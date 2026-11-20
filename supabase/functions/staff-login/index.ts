// ケアタイム勤怠：メールアドレスがないスタッフ用の「ログインID＋招待コード」を発行する（管理者専用）
//   action: "create" { staff_id }      → 新しいログインを作ってスタッフに紐付け、{ login_id, code } を返す
//   action: "reset"  { profile_id }    → そのIDログインの招待コードを作り直し、{ login_id, code } を返す
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// ログインIDはこのドメインのメールアドレスとして保存する（example.com は実在しない用途専用で、メールは届かない）
const ID_DOMAIN = "id.example.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const digits = (n: number) => {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => String(x % 10)).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST だけ受け付けます" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  // 呼び出した人が管理者かを確認
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "ログインしてください" }, 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "ログインしてください" }, 401);
  const { data: me } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
  if (me?.role !== "admin") return json({ error: "管理者だけが使えます" }, 403);

  let body: { action?: string; staff_id?: string; profile_id?: string };
  try { body = await req.json(); } catch { return json({ error: "内容が読めませんでした" }, 400); }

  if (body.action === "create") {
    const { data: staff } = await admin.from("staff").select("id,name").eq("id", body.staff_id ?? "").maybeSingle();
    if (!staff) return json({ error: "スタッフが見つかりません" }, 404);
    const code = digits(6);
    // 使われていない4桁のIDを探す
    for (let i = 0; i < 30; i++) {
      const loginId = String(1000 + Math.floor(Math.random() * 9000));
      const email = `${loginId}@${ID_DOMAIN}`;
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password: code, email_confirm: true, user_metadata: { name: staff.name, login_id: loginId },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) continue; // ID がかぶったら別の番号で
        return json({ error: "ログインを作れませんでした（" + error.message + "）" }, 500);
      }
      const uid = created.user!.id;
      const { error: upErr } = await admin.from("profiles")
        .update({ staff_id: staff.id, display_name: staff.name, role: "staff" }).eq("id", uid);
      if (upErr) return json({ error: "スタッフとの紐付けに失敗しました（" + upErr.message + "）" }, 500);
      return json({ login_id: loginId, code, name: staff.name });
    }
    return json({ error: "空いているIDが見つかりませんでした。もう一度お試しください" }, 500);
  }

  if (body.action === "reset") {
    const { data: target, error: tErr } = await admin.auth.admin.getUserById(body.profile_id ?? "");
    if (tErr || !target?.user) return json({ error: "アカウントが見つかりません" }, 404);
    const email = target.user.email || "";
    if (!email.endsWith("@" + ID_DOMAIN)) return json({ error: "メールアドレスで登録したアカウントは、本人が「パスワードを忘れた」から再設定してください" }, 400);
    const code = digits(6);
    const { error } = await admin.auth.admin.updateUserById(target.user.id, { password: code });
    if (error) return json({ error: "コードを作り直せませんでした（" + error.message + "）" }, 500);
    return json({ login_id: email.split("@")[0], code });
  }

  return json({ error: "action が正しくありません" }, 400);
});
