import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordUninstall } from "../models/installation.server";
import { leaveGroup } from "../models/stores.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  await recordUninstall(shop);
  await leaveGroup(shop); 

  return new Response();
};
