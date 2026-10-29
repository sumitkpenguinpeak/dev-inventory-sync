import db from "../db.server";

/** Install / re-install hone par record banave ya update kare. */
export async function recordInstall(session) {
  const now = new Date();
  return db.installation.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, scope: session.scope ?? null },
    update: { scope: session.scope ?? null, lastAuthAt: now, uninstalledAt: null },
  });
}

export async function recordUninstall(shop) {
  return db.installation.updateMany({
    where: { shop },
    data: { uninstalledAt: new Date() },
  });
}

export async function getInstallation(shop) {
  return db.installation.findUnique({ where: { shop } });
}
