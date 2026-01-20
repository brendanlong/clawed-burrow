/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `userId` on the `AuthSession` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "User_username_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "User";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT
);
INSERT INTO "new_AuthSession" ("createdAt", "expiresAt", "id", "token") SELECT "createdAt", "expiresAt", "id", "token" FROM "AuthSession";
DROP TABLE "AuthSession";
ALTER TABLE "new_AuthSession" RENAME TO "AuthSession";
CREATE UNIQUE INDEX "AuthSession_token_key" ON "AuthSession"("token");
CREATE INDEX "AuthSession_token_idx" ON "AuthSession"("token");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
