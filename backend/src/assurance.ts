import type { AuthenticatedRequest } from "./auth.js";
import { requireUser } from "./auth.js";
import { prisma } from "./db.js";
import { normalizeKenyanPhone } from "./lib/mpesa.js";
import { z } from "zod";

const assuranceSchema = z.object({
  documentType: z.enum(["NATIONAL_ID", "PASSPORT"]),
  guarantorFullName: z.string().trim().min(3).max(100),
  guarantorPhone: z.string().min(9).max(16),
  consent: z.literal(true)
});

const documentTypes = ["national-id-front", "national-id-back", "passport-bio-page", "selfie"] as const;
type DocumentType = typeof documentTypes[number];

export class AssuranceConfigurationError extends Error {}
export class AssuranceStorageError extends Error {}
export class AssuranceInputError extends Error {}

function storageConfig(): { url: string; key: string; bucket: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_ASSURANCE_BUCKET || "assurance-documents";
  if (!url || !key) {
    throw new AssuranceConfigurationError(
      "Private document storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend."
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AssuranceConfigurationError("SUPABASE_URL must be a valid HTTPS URL.");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new AssuranceConfigurationError("SUPABASE_URL must use HTTPS.");
  }
  return { url: parsedUrl.origin, key, bucket };
}

export function validateAssuranceImage(
  body: unknown,
  contentType: string | undefined
): { data: Buffer; mimeType: string; extension: string } {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AssuranceInputError("Select an image file to upload.");
  }
  const imageTypes = [
    { mimeType: "image/jpeg", extension: "jpg", matches: (data: Buffer) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
    { mimeType: "image/png", extension: "png", matches: (data: Buffer) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mimeType: "image/webp", extension: "webp", matches: (data: Buffer) => data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" }
  ];
  const image = imageTypes.find(candidate => candidate.mimeType === contentType && candidate.matches(body));
  if (!image) {
    throw new AssuranceInputError("Upload a valid JPEG, PNG, or WebP image.");
  }
  return { data: body, mimeType: image.mimeType, extension: image.extension };
}

async function uploadPrivateImage(
  userId: string,
  documentType: DocumentType,
  image: ReturnType<typeof validateAssuranceImage>,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const { url, key, bucket } = storageConfig();
  const path = `${userId}/${documentType}.${image.extension}`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const body = new Uint8Array(image.data.length);
  body.set(image.data);
  let response: Response;
  try {
    response = await fetcher(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": image.mimeType,
        "x-upsert": "true"
      },
      body,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new AssuranceStorageError("Private document storage could not be reached.", { cause: error });
  }
  if (!response.ok) {
    throw new AssuranceStorageError("Private document storage rejected the image upload.");
  }
  return path;
}

function documentResponse(assurance: {
  documentType: "NATIONAL_ID" | "PASSPORT";
  nationalIdFront: string | null;
  nationalIdBack: string | null;
  passportBioPage: string | null;
  selfie: string | null;
  guarantorFullName: string;
  guarantorPhone: string;
  consentedAt: Date | null;
  status: "DRAFT" | "SUBMITTED";
  submittedAt: Date | null;
}) {
  return {
    documentType: assurance.documentType,
    guarantorFullName: assurance.guarantorFullName,
    guarantorPhone: assurance.guarantorPhone,
    consentedAt: assurance.consentedAt,
    status: assurance.status,
    submittedAt: assurance.submittedAt,
    documents: {
      nationalIdFront: Boolean(assurance.nationalIdFront),
      nationalIdBack: Boolean(assurance.nationalIdBack),
      passportBioPage: Boolean(assurance.passportBioPage),
      selfie: Boolean(assurance.selfie)
    }
  };
}

export function createAssuranceRouter(express: typeof import("express")) {
  const router = express.Router();

  router.get("/assurance/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const assurance = await prisma.assurance.findUnique({ where: { userId: request.userId! } });
      response.json({ data: assurance ? documentResponse(assurance) : null });
    } catch (error) {
      next(error);
    }
  });

  router.put("/assurance/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const input = assuranceSchema.parse(request.body);
      const guarantorPhone = normalizeKenyanPhone(input.guarantorPhone);
      if (!guarantorPhone) {
        response.status(400).json({
          error: { code: "INVALID_GUARANTOR_PHONE", message: "Enter a valid Kenyan guarantor phone number." }
        });
        return;
      }
      const previous = await prisma.assurance.findUnique({
        where: { userId: request.userId! },
        select: {
          documentType: true,
          nationalIdFront: true,
          nationalIdBack: true,
          passportBioPage: true,
          selfie: true
        }
      });
      const hasUploadedDocuments = Boolean(
        previous?.nationalIdFront || previous?.nationalIdBack || previous?.passportBioPage || previous?.selfie
      );
      if (previous && previous.documentType !== input.documentType && hasUploadedDocuments) {
        response.status(409).json({
          error: {
            code: "ASSURANCE_DOCUMENT_TYPE_LOCKED",
            message: "The identity document type cannot be changed after images are uploaded. Contact support for help."
          }
        });
        return;
      }
      const documentReset = previous && previous.documentType !== input.documentType
        ? { nationalIdFront: null, nationalIdBack: null, passportBioPage: null, selfie: null }
        : {};
      const assurance = await prisma.assurance.upsert({
        where: { userId: request.userId! },
        create: {
          userId: request.userId!,
          documentType: input.documentType,
          guarantorFullName: input.guarantorFullName,
          guarantorPhone,
          consentedAt: new Date()
        },
        update: {
          documentType: input.documentType,
          guarantorFullName: input.guarantorFullName,
          guarantorPhone,
          consentedAt: new Date(),
          status: "DRAFT",
          submittedAt: null,
          ...documentReset
        }
      });
      response.json({ data: documentResponse(assurance) });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/assurance/me/documents/:documentType",
    requireUser,
    express.raw({ type: "image/*", limit: "8mb" }),
    async (request: AuthenticatedRequest, response, next) => {
      try {
        const documentType = z.enum(documentTypes).parse(request.params.documentType);
        const image = validateAssuranceImage(request.body, request.headers["content-type"]?.split(";")[0].trim());
        const existing = await prisma.assurance.findUnique({
          where: { userId: request.userId! },
          select: { documentType: true }
        });
        if (!existing) {
          response.status(409).json({
            error: { code: "ASSURANCE_DETAILS_REQUIRED", message: "Save your assurance details before uploading documents." }
          });
          return;
        }
        if (
          (existing.documentType === "NATIONAL_ID" && documentType === "passport-bio-page") ||
          (existing.documentType === "PASSPORT" && (documentType === "national-id-front" || documentType === "national-id-back"))
        ) {
          response.status(400).json({
            error: { code: "DOCUMENT_TYPE_MISMATCH", message: "Upload documents that match your selected identity document." }
          });
          return;
        }
        const path = await uploadPrivateImage(request.userId!, documentType, image);
        const fieldByType: Record<DocumentType, "nationalIdFront" | "nationalIdBack" | "passportBioPage" | "selfie"> = {
          "national-id-front": "nationalIdFront",
          "national-id-back": "nationalIdBack",
          "passport-bio-page": "passportBioPage",
          selfie: "selfie"
        };
        const updated = await prisma.assurance.update({
          where: { userId: request.userId! },
          data: { [fieldByType[documentType]]: path, status: "DRAFT", submittedAt: null }
        });
        response.json({ data: documentResponse(updated) });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/assurance/me/submit", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const assurance = await prisma.assurance.findUnique({ where: { userId: request.userId! } });
      if (!assurance) {
        response.status(409).json({
          error: { code: "ASSURANCE_DETAILS_REQUIRED", message: "Complete your assurance details before submitting." }
        });
        return;
      }
      const hasRequiredDocuments = assurance.documentType === "NATIONAL_ID"
        ? Boolean(assurance.nationalIdFront && assurance.nationalIdBack && assurance.selfie)
        : Boolean(assurance.passportBioPage && assurance.selfie);
      if (!hasRequiredDocuments || !assurance.consentedAt || !assurance.guarantorFullName || !assurance.guarantorPhone) {
        response.status(422).json({
          error: {
            code: "ASSURANCE_INCOMPLETE",
            message: assurance.documentType === "NATIONAL_ID"
              ? "Upload the front and back of your ID card and a selfie, and provide guarantor details."
              : "Upload your passport photo page and a selfie, and provide guarantor details."
          }
        });
        return;
      }
      const submitted = await prisma.assurance.update({
        where: { userId: request.userId! },
        data: { status: "SUBMITTED", submittedAt: new Date() }
      });
      response.json({ data: documentResponse(submitted) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
