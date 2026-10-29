import { useState } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  MAX_STORES,
  createGroup,
  getLink,
  joinGroup,
  leaveGroup,
  removeChild,
} from "../models/stores.server";
import { syncAll } from "../models/sync.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const link = await getLink(session.shop);

  if (!link) return { shop: session.shop, role: null, max: MAX_STORES };

  const group = link.group;
  const logs =
    link.role === "MASTER"
      ? await db.syncLog.findMany({
          where: { masterShop: group.masterShop },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [];

  return {
    shop: session.shop,
    role: link.role,
    max: MAX_STORES,
    masterShop: group.masterShop,
    joinCode: link.role === "MASTER" ? group.joinCode : null,
    stores: group.links.map((l) => ({ shop: l.shop, role: l.role })),
    logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  console.log("[stores action]", session.shop, intent);

  try {
    if (intent === "create") await createGroup(session.shop);
    else if (intent === "join") await joinGroup(session.shop, String(form.get("code") ?? ""));
    else if (intent === "leave") await leaveGroup(session.shop);
    else if (intent === "remove") await removeChild(session.shop, String(form.get("shop")));
    else if (intent === "sync_all") {
      const r = await syncAll(session.shop);
      return { ok: true, message: `${r.products} products sync thaya.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

export default function Stores() {
  const data = useLoaderData();
  const result = useActionData();
  const busy = useNavigation().state !== "idle";
  const submit = useSubmit();
  const [code, setCode] = useState("");
  const send = (intent, extra = {}) => submit({ intent, ...extra }, { method: "post" });

  return (
    <s-page heading="Multi-store sync">
      {result?.error && (
        <s-banner tone="critical" heading="Error">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      )}
      {result?.message && (
        <s-banner tone="success">
          <s-paragraph>{result.message}</s-paragraph>
        </s-banner>
      )}

      {!data.role && (
        <>
          <s-section heading="Aa store ne Master banavo">
            <s-paragraph>
              Aa store ma je price ane inventory badlase e bija connected stores ma sync thase.
            </s-paragraph>
            <s-button onClick={() => send("create")} {...(busy ? { loading: true } : {})}>
                Create master group
              </s-button>
          </s-section>

          <s-section heading="Master na group ma join thao">
            <s-stack direction="block" gap="base">
              <s-text-field
                name="code"
                label="Join code"
                details="Master store na Stores page par thi code lo"
                value={code}
                onInput={(e) => setCode(e.currentTarget.value)}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
              <s-button onClick={() => send("join", { code })}>Join group</s-button>
            </s-stack>
          </s-section>
        </>
      )}

      {data.role && (
        <>
          <s-section heading="Connected stores">
            <s-paragraph>
              {data.stores.length} / {data.max} stores connected. Aa store:{" "}
              <s-badge tone={data.role === "MASTER" ? "success" : "info"}>{data.role}</s-badge>
            </s-paragraph>
            <s-stack direction="block" gap="small-200">
              {data.stores.map((s) => (
                <s-stack key={s.shop} direction="inline" gap="base" alignItems="center">
                  <s-text>{s.shop}</s-text>
                  <s-badge tone={s.role === "MASTER" ? "success" : "neutral"}>{s.role}</s-badge>
                  {data.role === "MASTER" && s.role === "CHILD" && (
                    <s-button tone="critical" variant="tertiary" onClick={() => send("remove", { shop: s.shop })}>Remove</s-button>
                  )}
                </s-stack>
              ))}
            </s-stack>
          </s-section>

          {data.role === "MASTER" && (
            <>
              <s-section heading="Join code">
                <s-paragraph>
                  Child stores ma app install karine aa code nakho (baki 2 stores mate):
                </s-paragraph>
                <s-heading>{data.joinCode}</s-heading>
              </s-section>

              <s-section heading="Sync">
                <s-button onClick={() => send("sync_all")} {...(busy ? { loading: true } : {})}>
                  Sync all products now
                </s-button>
              </s-section>

              <s-section heading="Recent sync log" padding="none">
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Time</s-table-header>
                    <s-table-header>Child store</s-table-header>
                    <s-table-header>SKU</s-table-header>
                    <s-table-header>Field</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header>Message</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.logs.map((l) => (
                      <s-table-row key={l.id}>
                        <s-table-cell>{new Date(l.createdAt).toLocaleString()}</s-table-cell>
                        <s-table-cell>{l.childShop}</s-table-cell>
                        <s-table-cell>{l.sku ?? "-"}</s-table-cell>
                        <s-table-cell>{l.field}</s-table-cell>
                        <s-table-cell>
                          <s-badge tone={l.status === "OK" ? "success" : "critical"}>{l.status}</s-badge>
                        </s-table-cell>
                        <s-table-cell>{l.message ?? "-"}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-section>
            </>
          )}

          <s-section heading="Group chhodo">
            <s-paragraph>
              {data.role === "MASTER"
                ? "Master chhodso to puru group delete thai jase."
                : "Aa store master na group mathi nikli jase."}
            </s-paragraph>
            <s-button tone="critical" onClick={() => send("leave")}>Leave group</s-button>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
