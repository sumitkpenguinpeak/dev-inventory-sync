import { randomBytes } from "node:crypto";
import db from "../db.server";

export const MAX_STORES = 3; // 1 master + 2 child

const newCode = () => randomBytes(4).toString("hex").toUpperCase();

export async function getLink(shop) {
  return db.storeLink.findUnique({
    where: { shop },
    include: { group: { include: { links: { orderBy: { joinedAt: "asc" } } } } },
  });
}

export async function createGroup(shop) {
  if (await db.storeLink.findUnique({ where: { shop } })) {
    throw new Error("Aa store pehla thi koi group ma chhe.");
  }
  return db.storeGroup.create({
    data: {
      masterShop: shop,
      joinCode: newCode(),
      links: { create: { shop, role: "MASTER" } },
    },
  });
}

export async function joinGroup(shop, code) {
  if (await db.storeLink.findUnique({ where: { shop } })) {
    throw new Error("Aa store pehla thi koi group ma chhe.");
  }
  const group = await db.storeGroup.findUnique({
    where: { joinCode: code.trim().toUpperCase() },
    include: { links: true },
  });
  if (!group) throw new Error("Join code khoto chhe.");
  if (group.links.length >= MAX_STORES) {
    throw new Error(`Group ma max ${MAX_STORES} stores j hoi shake.`);
  }
  return db.storeLink.create({
    data: { groupId: group.id, shop, role: "CHILD" },
  });
}

/** Child hoy to potani link delete; master hoy to puru group delete (cascade). */
export async function leaveGroup(shop) {
  const link = await db.storeLink.findUnique({ where: { shop } });
  if (!link) return;
  if (link.role === "MASTER") {
    await db.storeGroup.delete({ where: { id: link.groupId } });
  } else {
    await db.storeLink.delete({ where: { shop } });
  }
}

/** Master potana group mathi child ne kadhi shake. */
export async function removeChild(masterShop, childShop) {
  const master = await db.storeLink.findUnique({ where: { shop: masterShop } });
  if (!master || master.role !== "MASTER") throw new Error("Fakat master j store kadhi shake.");
  const child = await db.storeLink.findUnique({ where: { shop: childShop } });
  if (!child || child.groupId !== master.groupId || child.role !== "CHILD") {
    throw new Error("Aa store tamara group ma nathi.");
  }
  await db.storeLink.delete({ where: { shop: childShop } });
}

/* ---------- Sync options (kya fields sync karva) ---------- */
export const DEFAULT_SYNC_FIELDS = {
  price: true,
  inventory: true,
  title: true,
  description: true,
  status: true,
  productType: true,
  vendor: true,
  tags: true,
  images: true,
};

export function parseSyncSettings(raw) {
  try {
    return { ...DEFAULT_SYNC_FIELDS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SYNC_FIELDS };
  }
}

export async function saveSyncSettings(masterShop, fields) {
  const master = await db.storeLink.findUnique({ where: { shop: masterShop } });
  if (!master || master.role !== "MASTER") throw new Error("Fakat master settings badli shake.");
  const clean = Object.fromEntries(
    Object.keys(DEFAULT_SYNC_FIELDS).map((k) => [k, Boolean(fields?.[k])]),
  );
  await db.storeGroup.update({
    where: { id: master.groupId },
    data: { settings: JSON.stringify(clean) },
  });
}