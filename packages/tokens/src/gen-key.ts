import { exportPKCS8, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
process.stdout.write(await exportPKCS8(privateKey));
