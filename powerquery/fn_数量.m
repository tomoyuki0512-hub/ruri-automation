// クエリ名: fn_数量
// 数量セルを数値にする。解釈できない場合は null を返す（呼び出し側で 0 として扱う）。
//
//   1234      → 1234    数値セルはそのまま
//   "1,234"   → 1234    桁区切り
//   "１２３"   → 123     全角数字
//   "(123)"   → -123    会計形式の負数
//   "△123"    → -123    日本の会計表記の負数
//   "123-"    → -123    SAP の後置マイナス
//   ""        → 0       空欄
//   "12台"    → null    数値以外が混ざるものは誤読を避けて解釈しない
(v as any) as nullable number =>
let
    結果 =
        if v = null then 0
        else if Value.Is(v, type number) then v
        else if Value.Is(v, type logical) then null
        else if Value.Is(v, type date) or Value.Is(v, type datetime) then null
        else
            let
                t0 = Text.Trim(Text.From(v)),

                // 全角英数字・記号（！〜～ = U+FF01〜U+FF5E）を半角へ
                t1 =
                    Text.Combine(
                        List.Transform(
                            Text.ToList(t0),
                            each
                                let c = Character.ToNumber(_) in
                                if c >= 65281 and c <= 65374
                                then Character.FromNumber(c - 65248)
                                else _
                        )
                    ),

                // 会計形式の括弧書き負数 (123)
                括弧 = Text.StartsWith(t1, "(") and Text.EndsWith(t1, ")"),
                t2   = if 括弧 then Text.Trim(Text.Middle(t1, 1, Text.Length(t1) - 2)) else t1,

                // 日本の会計表記の負数 △ ▲ − – — －
                先頭記号 = t2 <> "" and List.Contains({"△", "▲", "−", "–", "—", "－"}, Text.Start(t2, 1)),
                t3       = if 先頭記号 then Text.Trim(Text.Middle(t2, 1)) else t2,

                // SAP の後置マイナス 123-
                後置 = Text.EndsWith(t3, "-"),
                t4   = if 後置 then Text.Trim(Text.Start(t3, Text.Length(t3) - 1)) else t3,

                負数 = 括弧 or 先頭記号 or 後置,

                // 桁区切りと空白（半角・全角）を除去
                t5 = Text.Remove(t4, {",", " ", Character.FromNumber(12288)}),

                // 数字・小数点・符号以外が混ざるものは解釈しない
                // （"12台" を 12 と誤読させないため）
                許容文字 = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-"},
                有効 =
                    t5 <> ""
                    and List.IsEmpty(List.RemoveMatchingItems(Text.ToList(t5), 許容文字)),

                // ロケールに左右されないよう en-US 固定で変換する
                数値 = if 有効 then (try Number.FromText(t5, "en-US") otherwise null) else null
            in
                if t0 = "" then 0
                else if 数値 = null then null
                else if 負数 then -数値
                else 数値
in
    結果
