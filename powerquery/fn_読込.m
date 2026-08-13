// クエリ名: fn_読込
// Excel ファイルから指定した列だけを取り出す。
//
// 列は「位置」で指定する（A=Column1, B=Column2, E=Column5, G=Column7, I=Column9, J=Column10）。
// ヘッダ行は昇格させず、開始行より前を読み飛ばすだけにしている。
// 見出しの表記に依存しないので、ヘッダ名が変わっても動く。
//
//   path   : ファイルパス
//   開始行 : データが始まる行（1 始まり。1行目がヘッダなら 2）
//   列     : 取り出す列名のリスト 例 {"Column1", "Column5", "Column9"}
//   名前   : 付け替える列名のリスト 例 {"倉庫名", "型式", "数量"}
(path as text, 開始行 as number, 列 as list, 名前 as list) as table =>
let
    ブック = Excel.Workbook(File.Contents(path), null, true),

    // 先頭のワークシート（名前付き範囲やテーブルは対象外にする）
    シート一覧 = Table.SelectRows(ブック, each [Kind] = "Sheet"),
    シート =
        if Table.IsEmpty(シート一覧)
        then error Error.Record("シートなし", "ワークシートが見つかりません: " & path)
        else シート一覧{0}[Data],

    データ = Table.Skip(シート, 開始行 - 1),

    // 列が足りないファイルでもエラーにせず null にする
    抽出 = Table.SelectColumns(データ, 列, MissingField.UseNull),
    改名 = Table.RenameColumns(抽出, List.Zip({列, 名前}))
in
    改名
