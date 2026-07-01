import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepRetention } from "../src/retention";

// SEC-2026-07-01(E1): The Window sealed emails on orphaned/expired featured rows have no owner link
// (owner_id is set only on a winning enrol), so eraseOwner cannot reach them. The retention sweep must
// give them a time-based deletion path.
describe("retention sweep — The Window sealed emails (E1)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM featured_posts").run();
    await env.DB.prepare("DELETE FROM featured_orphaned_payments").run();
  });

  it("scrubs email_sealed on aged featured_posts and purges aged orphaned payments; leaves fresh rows", async () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString(); // 60d > the 30d window
    const fresh = new Date().toISOString();
    // An aged, owner-less (owner_id NULL) featured row that still holds a sealed receipt email.
    await env.DB.prepare(
      "INSERT INTO featured_posts (author_kind, public_summary, order_id, status, email_sealed, created_at) VALUES ('human','x',?1,'expired','sealed-old@x',?2)",
    ).bind("featured:human:old", old).run();
    await env.DB.prepare(
      "INSERT INTO featured_posts (author_kind, public_summary, order_id, status, email_sealed, created_at) VALUES ('human','y',?1,'live','sealed-new@x',?2)",
    ).bind("featured:human:new", fresh).run();
    await env.DB.prepare(
      "INSERT INTO featured_orphaned_payments (order_id, llamapay_payment_id, email_sealed, received_at) VALUES ('featured:human:old','pay_old','refund-old@x',?1)",
    ).bind(old).run();
    await env.DB.prepare(
      "INSERT INTO featured_orphaned_payments (order_id, llamapay_payment_id, email_sealed, received_at) VALUES ('featured:human:new','pay_new','refund-new@x',?1)",
    ).bind(fresh).run();

    await sweepRetention(env as unknown as Parameters<typeof sweepRetention>[0]);

    const oldPost = await env.DB.prepare("SELECT email_sealed FROM featured_posts WHERE order_id='featured:human:old'").first<{ email_sealed: string | null }>();
    const newPost = await env.DB.prepare("SELECT email_sealed FROM featured_posts WHERE order_id='featured:human:new'").first<{ email_sealed: string | null }>();
    expect(oldPost?.email_sealed ?? null).toBeNull(); // aged sealed email scrubbed
    expect(newPost?.email_sealed).toBe("sealed-new@x"); // fresh row untouched

    const orphOld = await env.DB.prepare("SELECT count(*) c FROM featured_orphaned_payments WHERE order_id='featured:human:old'").first<{ c: number }>();
    const orphNew = await env.DB.prepare("SELECT count(*) c FROM featured_orphaned_payments WHERE order_id='featured:human:new'").first<{ c: number }>();
    expect(Number(orphOld?.c)).toBe(0); // aged orphaned payment purged
    expect(Number(orphNew?.c)).toBe(1); // fresh orphaned payment kept
  });
});
