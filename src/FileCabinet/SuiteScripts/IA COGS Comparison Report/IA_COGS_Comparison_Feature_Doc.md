# DTS IA vs COGS Comparison Report

## Purpose

Report ini membandingkan nilai Inventory Adjustment dengan data COGS Calculation Line per item. Report dibuat dalam dua script:

- Suitelet untuk parameter, submit proses, status task, dan preview hasil.
- Map/Reduce untuk memproses data dan membuat output JSON/CSV.

Version 1 tetap disimpan sebagai versi Map/Reduce. Version 2 dibuat sebagai Suitelet-only karena queue Map/Reduce di account DTS cukup tinggi dan kurang cocok untuk report yang butuh hasil langsung.

Version 1:

- File Suitelet: `dts_ia_cogs_comparison_sl.js`
- File Map/Reduce: `dts_ia_cogs_comparison_mr.js`
- Suitelet hanya melempar parameter ke Map/Reduce, lalu menampilkan polling page sampai output JSON ditemukan.
- Form menampilkan loading overlay dan mengunci tombol submit saat submit task untuk mencegah double submit.
- Subsidiary multiselect dimuat melalui SuiteQL agar hanya menampilkan nama subsidiary tanpa parent hierarchy.
- View report memakai Tabulator dengan header warna per section.
- View report menampilkan Period dalam format `DD/MM/YYYY`, Subsidiary, Item, dan jumlah row. Parameter kosong ditampilkan sebagai `Semua`.
- Download utama memakai Excel-readable `.xls` server-side dari output JSON Map/Reduce, dengan header warna dan `mso-number-format`.
- Excel menampilkan nama report dan parameter Period, Subsidiary, serta Item sebelum header kolom.

Version 2:

- File: `dts_ia_cogs_comparison_v2_sl.js`
- Tidak memakai Map/Reduce.
- Suitelet langsung menjalankan dua SuiteQL agregasi: IA summary dan COGS summary.
- Hasil IA dan COGS digabung di memory per item.
- Form menampilkan loading overlay dan mengunci tombol submit saat proses berjalan untuk mencegah double submit.
- Subsidiary multiselect dimuat melalui SuiteQL agar hanya menampilkan nama subsidiary tanpa parent hierarchy.
- View report memakai Tabulator dengan header warna per section.
- View report menampilkan Period dalam format `DD/MM/YYYY`, Subsidiary, Item, dan jumlah row. Parameter kosong ditampilkan sebagai `Semua`.
- Download utama memakai Excel-readable `.xls` server-side dengan header warna dan `mso-number-format`.
- Excel menampilkan nama report dan parameter Period, Subsidiary, serta Item sebelum header kolom.
- Governance risk lebih tinggi, terutama untuk periode panjang, semua subsidiary, dan semua item.
- Cocok untuk periode/filter yang lebih sempit agar user tidak menunggu queue Map/Reduce.

Version 1 Suitelet juga menyediakan polling page seperti pola Laporan Kartu AP:

- `action=checkstatus`: endpoint JSON untuk polling status task.
- `action=viewreport`: tampilan report dengan third-party JavaScript grid.
- `action=data`: endpoint JSON untuk data report.
- `action=download`: download Excel server-side.

## Suitelet Parameters

- Start Date: date range awal report.
- End Date: date range akhir report.
- Subsidiary: multi select subsidiary.
- Item: multi select item, hanya item dengan type Inventory Part dan Assembly. Jika kosong, semua item diproses.

## Data Sources

### Inventory Adjustment

Source:

- `transaction`
- `transactionline`
- `item`
- `unitstypeuom`

Filter:

- `transaction.type = 'InvAdjst'`
- `BUILTIN.DF(transaction.custbody_dts_adjustment_type) = 'Transfer Order Outlet (By Script)'`
- `transaction.trandate` berdasarkan Start Date dan End Date
- `transactionline.subsidiary` berdasarkan parameter Subsidiary
- `item.itemtype IN ('InvtPart', 'Assembly')`
- `transactionline.mainline = 'F'`

Field utama:

- Item: `item.itemid`
- Display Name: `item.displayname`
- Stock Unit: `item.stockunit`
- IA unit: `transactionline.units`
- IA qty: `transactionline.quantity`
- IA estimated unit cost: `transactionline.rate`

### COGS Calculation

Source:

- `customrecord_dts_cogs_calculation_line`
- `customrecord_dts_inv_cogs_calculation`
- `item`
- `unitstypeuom`

Join:

- `customrecord_dts_inv_cogs_calculation.id = customrecord_dts_cogs_calculation_line.custrecord_dts_cogs_linked`
- `item.id = customrecord_dts_cogs_calculation_line.custrecord_dts_item_cogs_line`

Filter:

- `customrecord_dts_inv_cogs_calculation.custrecord_dts_inv_date_pos` berdasarkan Start Date dan End Date
- `customrecord_dts_inv_cogs_calculation.custrecord_dts_subsidiary_pos` berdasarkan parameter Subsidiary
- `customrecord_dts_cogs_calculation_line.custrecord_dts_item_cogs_line` berdasarkan parameter Item
- `item.itemtype IN ('InvtPart', 'Assembly')`

Field utama:

- COGS item: `custrecord_dts_item_cogs_line`
- COGS qty: `custrecord_dts_qty_item_cogs_line`
- COGS unit: `custrecord_dts_unit_item_cogs_line`
- COGS average cost: `custrecord_dts_acost_item_cogs_line`
- Invoice qty POS: `customrecord_dts_inv_cogs_calculation.custrecord_dts_inv_qty_pos`

## Conversion Logic

Report tidak bergantung pada field converted di custom record, supaya target unit dapat dikembangkan di masa depan.

Untuk versi awal, target unit adalah Stock Unit dari master item.

Conversion ratio:

```text
source_unit_conversion / target_unit_conversion
```

IA:

```text
IA Cost Average = AVG(transactionline.rate * conversion_ratio)
IA Qty = SUM(transactionline.quantity * conversion_ratio)
IA Cost = SUM(transactionline.quantity * transactionline.rate * conversion_ratio)
```

COGS:

```text
COGS Cost Average = AVG(custrecord_dts_acost_item_cogs_line * conversion_ratio)
COGS Qty = SUM(custrecord_dts_qty_item_cogs_line * custrecord_dts_inv_qty_pos * conversion_ratio)
COGS Cost = SUM(custrecord_dts_qty_item_cogs_line * custrecord_dts_inv_qty_pos * custrecord_dts_acost_item_cogs_line * conversion_ratio)
```

## Difference Logic

Version 1 dan Version 2 mengikuti koreksi Excel manual:

```text
Average Difference = COGS Cost Average - IA Cost Average
Average Percentage = Average Difference / IA Cost Average
Qty Difference = IA Qty + COGS Qty
Qty Percentage = Qty Difference / IA Qty
Value Difference = IA Cost + COGS Cost
```

Catatan: Qty dan Value memakai penjumlahan karena IA dari NetSuite bernilai negatif, sedangkan COGS bernilai positif.

## Output Columns

- Item
- Display Name
- Stock Unit
- IA Cost (Average)
- COGS Cost (Average)
- Difference
- Percentage
- IA Qty
- COGS Qty
- Difference Qty
- Percentage
- IA Cost
- COGS Cost
- Difference Value

Header Suitelet preview memakai warna berbeda untuk:

- Average section: kolom 4 sampai 7.
- Quantity section: kolom 8 sampai 11.
- Value section: kolom 12 sampai 14.

## Report Viewer And Excel Download

`jsreport` murni membutuhkan service Node/server eksternal, sehingga tidak dipakai langsung di Suitelet NetSuite. Implementasi saat ini memakai third-party browser library:

- Tabulator untuk grid report di `action=viewreport`.

Selain itu Suitelet menyediakan `action=download` yang membuat Excel-readable `.xls` dari HTML table. File `.xls` ini adalah output styled utama karena mendukung header warna dan `mso-number-format` tanpa service eksternal.

Polling page akan mengecek status Map/Reduce setiap beberapa detik. Setelah status `COMPLETE`, halaman akan menampilkan tombol:

- View Report
- Download Excel
- Generate New Report

## Script Parameters

Suitelet:

- Suitelet tidak memakai script parameter untuk submit MR.
- Script ID Map/Reduce hardcoded: `customscript_dts_ia_cogs_comparison_mr`.
- Deployment ID Map/Reduce hardcoded: `customdeploy_dts_ia_cogs_comparison_mr`.
- Output folder hardcoded: `499`.

Map/Reduce:

- `custscript_dts_iacogs_start_date`: diisi Suitelet.
- `custscript_dts_iacogs_end_date`: diisi Suitelet.
- `custscript_dts_iacogs_subsidiaries`: diisi Suitelet.
- `custscript_dts_iacogs_items`: diisi Suitelet.
- `custscript_dts_iacogs_mr_output_folder`: diisi Suitelet. Jika kosong, Map/Reduce memakai folder ID `499`.
- `custscript_dts_iacogs_run_id`: diisi Suitelet.

## Files

- `dts_ia_cogs_comparison_sl.js`: Suitelet report.
- `dts_ia_cogs_comparison_mr.js`: Map/Reduce processor.
- `dts_ia_cogs_comparison_v2_sl.js`: Suitelet-only report tanpa Map/Reduce.
- `IA_COGS_Comparison_Feature_Doc.md`: requirement dan feature note.

## Validation Notes

Debug awal yang sudah dikunci:

- `transactionline.rate` terbaca sebagai kandidat Est. Unit Cost dan match dengan amount IA ketika dikali quantity pada sample.
- `transactionline.costestimaterate`, `transactionline.costestimate`, dan `transactionline.inventorysubsidiary` tidak tersedia di channel SuiteQL account ini.
- `transaction.subsidiary` tidak tersedia di channel SuiteQL account ini, sehingga filter subsidiary IA memakai `transactionline.subsidiary`.
- Header COGS memakai `custrecord_dts_inv_date_pos` untuk tanggal dan `custrecord_dts_subsidiary_pos` untuk subsidiary.
- Field COGS converted existing tidak digunakan sebagai sumber utama, hanya sebagai referensi validasi.

## Setup Troubleshooting

Jika muncul error:

```text
INVALID_ID: You have provided an invalid script id or internal id
```

Artinya Suitelet belum menemukan script record/deployment Map/Reduce di account. Buat script record Map/Reduce untuk file:

```text
/SuiteScripts/IA COGS Comparison Report/dts_ia_cogs_comparison_mr.js
```

Gunakan default id berikut:

```text
Script ID: customscript_dts_ia_cogs_comparison_mr
Deployment ID: customdeploy_dts_ia_cogs_comparison_mr
```
