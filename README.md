# ケアタイム勤怠（Supabase版） セットアップ手順

スタッフ用（`staff.html`）と管理者用（`admin.html`）の2画面です。データはSupabaseに保存されます。
スタッフは**メールアドレスとパスワード**でログインするので、claude.ai のアカウントはいりません。

## ファイル

| ファイル | 役割 |
|---|---|
| `schema.sql` | データベースの設定。Supabaseで1回だけ実行 |
| `config.js` | 接続先（Project URL と Publishable key）を書く |
| `staff.html` | スタッフ用：出勤・退勤、シフト、修正依頼、ケア記録 |
| `admin.html` | 管理者用：今日の状況、勤怠一覧、依頼承認、給与計算、シフト、スタッフ、設定 |
| `common.js` / `common.css` | 両方の画面で使う部品 |

## 1. Supabaseでプロジェクトを作る
1. https://supabase.com に新しいアカウントでログインして「New project」を作成（Region は **Tokyo (ap-northeast-1)** がおすすめ）
2. 左メニューの **SQL Editor** を開き、`schema.sql` の中身を全部貼り付けて **Run**

## 2. ログインの設定
**Authentication → URL Configuration**
- **Site URL** に、このアプリを置くURL（例：`https://caretime-xxxx.netlify.app/staff.html`）
- **Redirect URLs** に `https://caretime-xxxx.netlify.app/**` を追加

（確認メールやパスワード再設定のリンクがこのURLに戻ってきます）

確認メールを省きたいときは **Authentication → Sign In / Providers → Email → Confirm email** をオフにできます。オフにすると、URLを知っている人なら誰でもアカウントを作れます。ただし管理者が紐付けるまでは、何も見られず何もできません。

## 3. config.js を書き換える
**Project Settings → API**（または上部の「Connect」）で次の2つをコピーして `config.js` に貼ります。
- Project URL
- Publishable key（`sb_publishable_...`）。古いプロジェクトなら anon public key

⚠ `service_role` / `secret` キーは絶対に入れないでください。

## 4. ネットに置く
フォルダごと、静的サイトを置けるサービスにアップロードします。
- いちばん簡単：**Netlify Drop**（https://app.netlify.com/drop）にフォルダをドラッグ＆ドロップ
- ほかに Vercel、Cloudflare Pages、GitHub Pages など

## 5. 使い始める
1. **オーナーが最初に** `admin.html` を開き、「はじめての方はこちら」からアカウント登録します。最初に登録した1人が自動で管理者になります
2. 管理画面の「スタッフ」タブで、スタッフの名前・時給・交通費を登録します
3. スタッフに `staff.html` のURLを送ります。スタッフがアカウント登録すると、管理画面の「登録されたアカウント」に「紐付け待ち」で出てきます
4. スタッフ名を選んで「保存」すると、そのスタッフが出勤・退勤できるようになります
5. ほかの人を管理者にするときも、同じ一覧で権限を「管理者」にします

スマホでは `staff.html` を開いて「ホーム画面に追加」すると、アプリのように使えます。

## しくみ（安全面）
- 出勤・退勤の時刻は**サーバーの時計**で記録します。スマホの時計をずらしても不正はできません
- スタッフが見られるのは、自分のシフト・自分の勤務記録・自分の依頼・ケア記録（全員で共有）だけです。他人の時給は見えません
- 勤務記録を直接書き換えられるのは管理者だけです。スタッフは修正依頼を出し、管理者が承認すると自動で反映されます
- 勤務日と夜勤の日付は日本時間で扱います

## 給与計算のルール（設定タブで変更可）
- 実働 ＝ 退勤 − 出勤 − 休憩
- 深夜（22時〜翌5時）は時給の25%を上乗せ。休憩は、勤務時間全体に対する割合で深夜の時間からも引きます
- 1日8時間を超えた分は25%を上乗せ（週40時間を超えた分は計算に入りません）
- 交通費 ＝ 出勤日数 × 1日あたりの額
- 社会保険・所得税を引く**前**の金額です

## 最初に登録した人が管理者にならなかったとき
SQL Editor で次を実行してください（メールアドレスは自分のものに変えてください）。
```sql
update public.profiles set role = 'admin' where email = 'あなたのメールアドレス';
```
