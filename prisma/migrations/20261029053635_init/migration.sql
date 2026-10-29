-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "Installation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "scope" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME
);

-- CreateTable
CREATE TABLE "StoreGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "masterShop" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StoreLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "StoreGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "masterShop" TEXT NOT NULL,
    "childShop" TEXT NOT NULL,
    "sku" TEXT,
    "field" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Installation_shop_key" ON "Installation"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "StoreGroup_masterShop_key" ON "StoreGroup"("masterShop");

-- CreateIndex
CREATE UNIQUE INDEX "StoreGroup_joinCode_key" ON "StoreGroup"("joinCode");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLink_shop_key" ON "StoreLink"("shop");

-- CreateIndex
CREATE INDEX "SyncLog_masterShop_createdAt_idx" ON "SyncLog"("masterShop", "createdAt");
