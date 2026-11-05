import "dotenv/config";
import app from "./app.js";
import { prisma } from "./db.js";

const port = Number(process.env.PORT || 3000);


await prisma.$connect();
app.listen(port, () => {
  console.log(`DeniCash API listening on port ${port}`);
});
