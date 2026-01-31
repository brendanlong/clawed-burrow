-- CreateTable
CREATE TABLE "RepoSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoFullName" TEXT NOT NULL,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EnvVar_repoSettingsId_fkey" FOREIGN KEY ("repoSettingsId") REFERENCES "RepoSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "args" TEXT,
    "env" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServer_repoSettingsId_fkey" FOREIGN KEY ("repoSettingsId") REFERENCES "RepoSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RepoSettings_repoFullName_key" ON "RepoSettings"("repoFullName");

-- CreateIndex
CREATE INDEX "RepoSettings_isFavorite_idx" ON "RepoSettings"("isFavorite");

-- CreateIndex
CREATE INDEX "EnvVar_repoSettingsId_idx" ON "EnvVar"("repoSettingsId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVar_repoSettingsId_name_key" ON "EnvVar"("repoSettingsId", "name");

-- CreateIndex
CREATE INDEX "McpServer_repoSettingsId_idx" ON "McpServer"("repoSettingsId");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_repoSettingsId_name_key" ON "McpServer"("repoSettingsId", "name");
