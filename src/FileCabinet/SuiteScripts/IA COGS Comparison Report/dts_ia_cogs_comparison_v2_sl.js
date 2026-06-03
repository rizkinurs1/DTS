/**
 * DTS IA vs COGS Comparison Report Suitelet V2.
 * Suitelet-only version. No Map/Reduce queue dependency.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/file',
    'N/format',
    'N/log',
    'N/query',
    'N/runtime',
    'N/ui/serverWidget'
], function (file, format, log, query, runtime, serverWidget) {
    var ITEM_OPTION_LIMIT = 4000;

    function onRequest(context) {
        var params = context.request.parameters || {};

        if (params.action === 'download') {
            downloadExcel(context);
            return;
        }

        if (context.request.method === 'POST') {
            writeReport(context);
            return;
        }

        writeForm(context, params);
    }

    function writeForm(context, params) {
        var form = serverWidget.createForm({
            title: 'DTS IA vs COGS Comparison Report V2'
        });

        var group = form.addFieldGroup({
            id: 'custpage_filter_group',
            label: 'Report Parameters'
        });

        var startDate = form.addField({
            id: 'custpage_start_date',
            type: serverWidget.FieldType.DATE,
            label: 'Start Date',
            container: group.id
        });
        startDate.isMandatory = true;

        var endDate = form.addField({
            id: 'custpage_end_date',
            type: serverWidget.FieldType.DATE,
            label: 'End Date',
            container: group.id
        });
        endDate.isMandatory = true;

        var subsidiary = form.addField({
            id: 'custpage_subsidiary',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Subsidiary',
            source: 'subsidiary',
            container: group.id
        });

        var item = form.addField({
            id: 'custpage_item',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Item',
            container: group.id
        });
        addItemOptions(item, form);

        if (params.custpage_start_date) {
            startDate.defaultValue = params.custpage_start_date;
        }
        if (params.custpage_end_date) {
            endDate.defaultValue = params.custpage_end_date;
        }
        if (params.custpage_subsidiary) {
            subsidiary.defaultValue = multiDefault(params.custpage_subsidiary);
        }
        if (params.custpage_item) {
            item.defaultValue = multiDefault(params.custpage_item);
        }

        form.addSubmitButton({
            label: 'Generate Report'
        });

        addSubmitLoadingGuard(form);

        context.response.writePage(form);
    }

    function writeReport(context) {
        try {
            var config = getConfig(context.request.parameters || {});
            var rows = generateRows(config);
            var downloadUrl = buildDownloadUrl(config);

            context.response.write(buildReportHtml(rows, config, downloadUrl));
        } catch (e) {
            log.error({
                title: 'Generate report failed',
                details: e
            });
            writeErrorPage(context, 'Gagal generate report', [e.message || e.name]);
        }
    }

    function downloadExcel(context) {
        try {
            var config = getConfig(context.request.parameters || {});
            var rows = generateRows(config);
            var reportFile = file.create({
                name: buildFileName(config) + '.xls',
                fileType: file.Type.HTMLDOC,
                contents: buildExcelHtml(rows)
            });

            context.response.writeFile({
                file: reportFile,
                isInline: false
            });
        } catch (e) {
            log.error({
                title: 'Download report failed',
                details: e
            });
            writeErrorPage(context, 'Gagal download Excel', [e.message || e.name]);
        }
    }

    function generateRows(config) {
        var rowsByItem = {};

        runIaSummary(config).forEach(function (row) {
            var itemId = String(row.item_id);
            rowsByItem[itemId] = rowsByItem[itemId] || buildEmptyRow(itemId, row);
            rowsByItem[itemId].iaCostAverage = toNumber(row.cost_average);
            rowsByItem[itemId].iaQty = toNumber(row.qty);
            rowsByItem[itemId].iaCost = toNumber(row.amount);
        });

        runCogsSummary(config).forEach(function (row) {
            var itemId = String(row.item_id);
            rowsByItem[itemId] = rowsByItem[itemId] || buildEmptyRow(itemId, row);
            rowsByItem[itemId].cogsCostAverage = toNumber(row.cost_average);
            rowsByItem[itemId].cogsQty = toNumber(row.qty);
            rowsByItem[itemId].cogsCost = toNumber(row.amount);
        });

        var rows = Object.keys(rowsByItem).map(function (itemId) {
            return finalizeRow(rowsByItem[itemId]);
        });

        rows.sort(function (a, b) {
            return String(a.item || '').localeCompare(String(b.item || ''));
        });

        return rows;
    }

    function runIaSummary(config) {
        var params = [config.startDate, config.endDate];
        var subsidiaryCondition = buildInCondition('tl.subsidiary', config.subsidiaries, params);
        var itemCondition = buildInCondition('i.id', config.items, params);
        var conversionRatio = 'NVL(src_uom.conversionrate, 1) / NULLIF(NVL(target_uom.conversionrate, 1), 0)';

        var sql = [
            'SELECT',
            'i.id AS item_id,',
            'i.itemid AS item_code,',
            'i.displayname AS display_name,',
            'BUILTIN.DF(i.stockunit) AS stock_unit,',
            'AVG(NVL(tl.rate, 0) * ' + conversionRatio + ') AS cost_average,',
            'SUM(NVL(tl.quantity, 0) * ' + conversionRatio + ') AS qty,',
            'SUM(NVL(tl.quantity, 0) * NVL(tl.rate, 0) * ' + conversionRatio + ') AS amount',
            'FROM transaction t',
            'JOIN transactionline tl ON tl.transaction = t.id',
            'JOIN item i ON i.id = tl.item',
            'LEFT JOIN unitstypeuom src_uom ON src_uom.internalid = tl.units',
            'LEFT JOIN unitstypeuom target_uom ON target_uom.internalid = i.stockunit',
            "WHERE t.type = 'InvAdjst'",
            "AND BUILTIN.DF(t.custbody_dts_adjustment_type) = 'Transfer Order Outlet (By Script)'",
            "AND t.trandate BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD')",
            "AND i.itemtype IN ('InvtPart', 'Assembly')",
            "AND NVL(tl.mainline, 'F') = 'F'",
            'AND ' + subsidiaryCondition,
            'AND ' + itemCondition,
            'GROUP BY i.id, i.itemid, i.displayname, BUILTIN.DF(i.stockunit)'
        ].join(' ');

        return runPaged(sql, params);
    }

    function runCogsSummary(config) {
        var params = [config.startDate, config.endDate];
        var subsidiaryCondition = buildInCondition('h.custrecord_dts_subsidiary_pos', config.subsidiaries, params);
        var itemCondition = buildInCondition('i.id', config.items, params);
        var conversionRatio = 'NVL(src_uom.conversionrate, 1) / NULLIF(NVL(target_uom.conversionrate, 1), 0)';
        var rawQty = "TO_NUMBER(NVL(l.custrecord_dts_qty_item_cogs_line, '0'))";
        var invoiceQty = "TO_NUMBER(NVL(h.custrecord_dts_inv_qty_pos, '0'))";
        var averageCost = 'NVL(l.custrecord_dts_acost_item_cogs_line, 0)';

        var sql = [
            'SELECT',
            'i.id AS item_id,',
            'i.itemid AS item_code,',
            'i.displayname AS display_name,',
            'BUILTIN.DF(i.stockunit) AS stock_unit,',
            'AVG(' + averageCost + ' * ' + conversionRatio + ') AS cost_average,',
            'SUM(' + rawQty + ' * ' + invoiceQty + ' * ' + conversionRatio + ') AS qty,',
            'SUM(' + rawQty + ' * ' + invoiceQty + ' * ' + averageCost + ' * ' + conversionRatio + ') AS amount',
            'FROM customrecord_dts_cogs_calculation_line l',
            'JOIN customrecord_dts_inv_cogs_calculation h ON h.id = l.custrecord_dts_cogs_linked',
            'JOIN item i ON i.id = l.custrecord_dts_item_cogs_line',
            'LEFT JOIN unitstypeuom src_uom ON src_uom.internalid = l.custrecord_dts_unit_item_cogs_line',
            'LEFT JOIN unitstypeuom target_uom ON target_uom.internalid = i.stockunit',
            "WHERE h.custrecord_dts_inv_date_pos BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD')",
            "AND i.itemtype IN ('InvtPart', 'Assembly')",
            'AND ' + subsidiaryCondition,
            'AND ' + itemCondition,
            'GROUP BY i.id, i.itemid, i.displayname, BUILTIN.DF(i.stockunit)'
        ].join(' ');

        return runPaged(sql, params);
    }

    function runPaged(sql, params) {
        var rows = [];
        var paged = query.runSuiteQLPaged({
            query: sql,
            params: params,
            pageSize: 1000
        });

        paged.pageRanges.forEach(function (range) {
            var page = paged.fetch({ index: range.index });
            rows = rows.concat(page.data.asMappedResults());
        });

        return rows;
    }

    function buildInCondition(fieldId, values, params) {
        if (!values || !values.length) {
            return '1 = 1';
        }

        values.forEach(function (value) {
            params.push(Number(value));
        });

        return fieldId + ' IN (' + values.map(function () {
            return '?';
        }).join(', ') + ')';
    }

    function buildEmptyRow(itemId, sourceRow) {
        return {
            itemId: itemId,
            item: sourceRow.item_code || '',
            displayName: sourceRow.display_name || '',
            stockUnit: sourceRow.stock_unit || '',
            iaCostAverage: 0,
            cogsCostAverage: 0,
            costAverageDifference: 0,
            costAveragePercentage: null,
            iaQty: 0,
            cogsQty: 0,
            qtyDifference: 0,
            qtyPercentage: null,
            iaCost: 0,
            cogsCost: 0,
            valueDifference: 0
        };
    }

    function finalizeRow(row) {
        row.costAverageDifference = row.iaCostAverage - row.cogsCostAverage;
        row.costAveragePercentage = safeDivide(row.costAverageDifference, row.iaCostAverage);

        // IA dari NetSuite bernilai negatif, mengikuti screenshot maka compare qty/value memakai IA + COGS.
        row.qtyDifference = row.iaQty + row.cogsQty;
        row.qtyPercentage = safeDivide(row.qtyDifference, row.iaQty);
        row.valueDifference = row.iaCost + row.cogsCost;

        [
            'iaCostAverage',
            'cogsCostAverage',
            'costAverageDifference',
            'costAveragePercentage',
            'iaQty',
            'cogsQty',
            'qtyDifference',
            'qtyPercentage',
            'iaCost',
            'cogsCost',
            'valueDifference'
        ].forEach(function (fieldId) {
            if (row[fieldId] !== null && row[fieldId] !== undefined) {
                row[fieldId] = round(row[fieldId], 6);
            }
        });

        return row;
    }

    function buildReportHtml(rows, config, downloadUrl) {
        return [
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>DTS IA vs COGS Comparison V2</title>',
            '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/css/tabulator_bootstrap4.min.css">',
            '<script src="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/js/tabulator.min.js"></script>',
            '<script src="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/SheetJS/xlsx.full.min.js"></script>',
            '<style>',
            'body{font-family:Arial,sans-serif;margin:0;background:#f6f8fb;color:#26323f}.wrap{padding:18px 22px}',
            '.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}.title{font-size:20px;font-weight:bold;margin-right:auto}',
            '.btn{border:1px solid #2f5496;background:#2f5496;color:#fff;border-radius:5px;padding:8px 12px;text-decoration:none;cursor:pointer;font-size:13px}',
            '.btn.secondary{background:#fff;color:#2f5496}.meta{font-size:12px;color:#667789;margin-bottom:10px}',
            '#reportTable{background:#fff;border:1px solid #d9e0e8}.tabulator{font-size:12px}',
            '.tabulator .tabulator-col.base-head,.tabulator .tabulator-col.base-head .tabulator-col-content{background:#e7edf7!important}',
            '.tabulator .tabulator-col.avg-head,.tabulator .tabulator-col.avg-head .tabulator-col-content{background:#e8f3e3!important}',
            '.tabulator .tabulator-col.qty-head,.tabulator .tabulator-col.qty-head .tabulator-col-content{background:#e4eefb!important}',
            '.tabulator .tabulator-col.value-head,.tabulator .tabulator-col.value-head .tabulator-col-content{background:#f8e2e3!important}',
            '.tabulator .tabulator-col .tabulator-col-title{white-space:normal;text-overflow:clip;color:#1f2933}',
            '</style></head><body><div class="wrap">',
            '<div class="toolbar"><div class="title">DTS IA vs COGS Comparison V2</div>',
            '<a class="btn" href="', escapeHtml(downloadUrl), '">Download Excel</a>',
            '<button id="xlsxBtn" class="btn secondary">Download XLSX Data</button>',
            '<a class="btn secondary" href="', escapeHtml(getBaseUrl()), '">Buat Report Baru</a></div>',
            '<div class="meta">Period: ', escapeHtml(config.startDate), ' to ', escapeHtml(config.endDate),
            ' | Rows: ', rows.length, '</div>',
            '<div id="reportTable"></div></div>',
            '<script>',
            'var rows=', JSON.stringify(rows), ';',
            'function n(v){return Number(v||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}',
            'function p(v){if(v===null||v===undefined||v==="")return "";return n(Number(v)*100)+"%";}',
            'function excelRows(){return rows.map(function(r){return {"Item":r.item,"Display Name":r.displayName,"Stock Unit":r.stockUnit,',
            '"IA Cost (Average)":r.iaCostAverage,"COGS Cost (Average)":r.cogsCostAverage,"Difference":r.costAverageDifference,',
            '"Percentage":r.costAveragePercentage,"IA Qty":r.iaQty,"COGS Qty":r.cogsQty,"Difference Qty":r.qtyDifference,',
            '"Percentage Qty":r.qtyPercentage,"IA Cost":r.iaCost,"COGS Cost":r.cogsCost,"Difference Value":r.valueDifference};});}',
            'document.getElementById("xlsxBtn").onclick=function(){var wb=XLSX.utils.book_new();',
            'var ws=XLSX.utils.json_to_sheet(excelRows());XLSX.utils.book_append_sheet(wb,ws,"IA vs COGS");',
            'XLSX.writeFile(wb,"dts_ia_cogs_comparison_v2.xlsx");};',
            'new Tabulator("#reportTable",{data:rows,layout:"fitDataStretch",height:"75vh",pagination:true,paginationSize:100,movableColumns:true,columns:[',
            '{title:"Item",field:"item",frozen:true,headerCssClass:"base-head"},{title:"Display Name",field:"displayName",headerCssClass:"base-head"},{title:"Stock Unit",field:"stockUnit",headerCssClass:"base-head"},',
            '{title:"Average Cost",headerCssClass:"avg-head",columns:[',
            '{title:"IA Cost (Average)",field:"iaCostAverage",hozAlign:"right",headerCssClass:"avg-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Cost (Average)",field:"cogsCostAverage",hozAlign:"right",headerCssClass:"avg-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference",field:"costAverageDifference",hozAlign:"right",headerCssClass:"avg-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"Percentage",field:"costAveragePercentage",hozAlign:"right",headerCssClass:"avg-head",formatter:function(c){return p(c.getValue());}}]},',
            '{title:"Quantity",headerCssClass:"qty-head",columns:[',
            '{title:"IA Qty",field:"iaQty",hozAlign:"right",headerCssClass:"qty-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Qty",field:"cogsQty",hozAlign:"right",headerCssClass:"qty-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference Qty",field:"qtyDifference",hozAlign:"right",headerCssClass:"qty-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"Percentage",field:"qtyPercentage",hozAlign:"right",headerCssClass:"qty-head",formatter:function(c){return p(c.getValue());}}]},',
            '{title:"Value",headerCssClass:"value-head",columns:[',
            '{title:"IA Cost",field:"iaCost",hozAlign:"right",headerCssClass:"value-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Cost",field:"cogsCost",hozAlign:"right",headerCssClass:"value-head",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference Value",field:"valueDifference",hozAlign:"right",headerCssClass:"value-head",formatter:function(c){return n(c.getValue());}}]}]});',
            '</script></body></html>'
        ].join('');
    }

    function buildExcelHtml(rows) {
        var html = [
            '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">',
            '<style>',
            'table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt}',
            'th,td{border:1px solid #9aa7b4;padding:4px 6px;white-space:nowrap}',
            'th{text-align:center;font-weight:bold;color:#1f2933}',
            '.base{background:#e7edf7}.avg{background:#e8f3e3}.qty{background:#e4eefb}.val{background:#f8e2e3}',
            '.num{mso-number-format:"#,##0.00";text-align:right}.pct{mso-number-format:"0.00%";text-align:right}',
            '</style></head><body><table><tr>',
            '<th class="base" rowspan="2">Item</th><th class="base" rowspan="2">Display Name</th><th class="base" rowspan="2">Stock Unit</th>',
            '<th class="avg" colspan="4">Average Cost</th>',
            '<th class="qty" colspan="4">Quantity</th>',
            '<th class="val" colspan="3">Value</th>',
            '</tr><tr>',
            '<th class="avg">IA Cost (Average)</th><th class="avg">COGS Cost (Average)</th><th class="avg">Difference</th><th class="avg">Percentage</th>',
            '<th class="qty">IA Qty</th><th class="qty">COGS Qty</th><th class="qty">Difference Qty</th><th class="qty">Percentage</th>',
            '<th class="val">IA Cost</th><th class="val">COGS Cost</th><th class="val">Difference Value</th>',
            '</tr>'
        ];

        (rows || []).forEach(function (row) {
            html.push('<tr>');
            html.push('<td>', escapeHtml(row.item || ''), '</td>');
            html.push('<td>', escapeHtml(row.displayName || ''), '</td>');
            html.push('<td>', escapeHtml(row.stockUnit || ''), '</td>');
            html.push(excelNum(row.iaCostAverage));
            html.push(excelNum(row.cogsCostAverage));
            html.push(excelNum(row.costAverageDifference));
            html.push(excelPct(row.costAveragePercentage));
            html.push(excelNum(row.iaQty));
            html.push(excelNum(row.cogsQty));
            html.push(excelNum(row.qtyDifference));
            html.push(excelPct(row.qtyPercentage));
            html.push(excelNum(row.iaCost));
            html.push(excelNum(row.cogsCost));
            html.push(excelNum(row.valueDifference));
            html.push('</tr>');
        });

        html.push('</table></body></html>');
        return html.join('');
    }

    function addItemOptions(field, form) {
        field.addSelectOption({
            value: '',
            text: ''
        });

        try {
            var paged = query.runSuiteQLPaged({
                query: [
                    'SELECT id, itemid, displayname',
                    'FROM item',
                    "WHERE itemtype IN ('InvtPart', 'Assembly')",
                    "AND NVL(isinactive, 'F') = 'F'",
                    'ORDER BY itemid'
                ].join(' '),
                pageSize: 1000
            });
            var count = 0;

            paged.pageRanges.some(function (range) {
                var page = paged.fetch({ index: range.index });
                page.data.asMappedResults().some(function (row) {
                    if (count >= ITEM_OPTION_LIMIT) {
                        return true;
                    }

                    field.addSelectOption({
                        value: String(row.id),
                        text: row.displayname ? row.itemid + ' - ' + row.displayname : row.itemid
                    });
                    count += 1;
                    return false;
                });

                return count >= ITEM_OPTION_LIMIT;
            });

            if (count >= ITEM_OPTION_LIMIT) {
                addMessage(form, 'Item list dibatasi ' + ITEM_OPTION_LIMIT + ' opsi pertama. Kosongkan Item untuk proses semua item.');
            }
        } catch (e) {
            log.error({
                title: 'Load item options failed',
                details: e
            });
            addMessage(form, 'Item option gagal dimuat. Kosongkan Item untuk proses semua item.');
        }
    }

    function addMessage(form, text) {
        var field = form.addField({
            id: 'custpage_message',
            type: serverWidget.FieldType.INLINEHTML,
            label: 'Message'
        });
        field.defaultValue = '<div class="uir-alert-box warning">' + escapeHtml(text) + '</div>';
    }

    function addSubmitLoadingGuard(form) {
        var field = form.addField({
            id: 'custpage_submit_guard',
            type: serverWidget.FieldType.INLINEHTML,
            label: 'Submit Guard'
        });

        field.defaultValue = [
            '<style>',
            '#dtsLoadingOverlay{display:none;position:fixed;z-index:99999;inset:0;background:rgba(246,248,251,.84);',
            'align-items:center;justify-content:center;font-family:Arial,sans-serif;color:#26323f}',
            '#dtsLoadingOverlay .box{background:#fff;border:1px solid #d8e0e8;border-radius:8px;padding:26px 32px;',
            'box-shadow:0 10px 30px rgba(20,40,70,.14);text-align:center;min-width:300px}',
            '@keyframes dtsSpin{to{transform:rotate(360deg)}}',
            '#dtsLoadingOverlay .spinner{width:42px;height:42px;border:4px solid #e1e8f0;border-top-color:#2f5496;',
            'border-radius:50%;margin:0 auto 16px;animation:dtsSpin .8s linear infinite}',
            '#dtsLoadingOverlay .title{font-weight:bold;color:#2f5496;margin-bottom:6px}',
            '#dtsLoadingOverlay .sub{font-size:12px;color:#667085}',
            '</style>',
            '<div id="dtsLoadingOverlay"><div class="box"><div class="spinner"></div>',
            '<div class="title">Generating report...</div>',
            '<div class="sub">Please wait, Suitelet is processing the data.</div>',
            '</div></div>',
            '<script>',
            '(function(){',
            'var locked=false;',
            'function show(){',
            'if(locked)return false;',
            'locked=true;',
            'var overlay=document.getElementById("dtsLoadingOverlay");',
            'if(overlay)overlay.style.display="flex";',
            'var buttons=document.querySelectorAll("input[type=submit],button[type=submit],input[value=\\"Generate Report\\"]");',
            'for(var i=0;i<buttons.length;i++){buttons[i].disabled=true;buttons[i].style.opacity=".65";}',
            'return true;',
            '}',
            'function bind(){',
            'var forms=document.getElementsByTagName("form");',
            'if(forms&&forms.length){forms[0].onsubmit=function(){return show();};}',
            'var buttons=document.querySelectorAll("input[type=submit],button[type=submit],input[value=\\"Generate Report\\"]");',
            'for(var i=0;i<buttons.length;i++){buttons[i].onclick=function(){setTimeout(show,0);};}',
            '}',
            'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",bind);}else{bind();}',
            '}());',
            '</script>'
        ].join('');
    }

    function getConfig(params) {
        return {
            startDate: toIsoDate(params.custpage_start_date),
            endDate: toIsoDate(params.custpage_end_date),
            subsidiaries: normalizeMulti(params.custpage_subsidiary),
            items: normalizeMulti(params.custpage_item)
        };
    }

    function buildDownloadUrl(config) {
        var parts = [
            getBaseUrl(),
            '&action=download',
            '&custpage_start_date=' + encodeURIComponent(config.startDate),
            '&custpage_end_date=' + encodeURIComponent(config.endDate)
        ];

        if (config.subsidiaries.length) {
            parts.push('&custpage_subsidiary=' + encodeURIComponent(config.subsidiaries.join(',')));
        }
        if (config.items.length) {
            parts.push('&custpage_item=' + encodeURIComponent(config.items.join(',')));
        }

        return parts.join('');
    }

    function getBaseUrl() {
        var script = runtime.getCurrentScript();
        return '/app/site/hosting/scriptlet.nl?script=' + encodeURIComponent(script.id) + '&deploy=' + encodeURIComponent(script.deploymentId);
    }

    function buildFileName(config) {
        return 'dts_ia_cogs_comparison_v2_' + config.startDate + '_' + config.endDate;
    }

    function writeErrorPage(context, title, lines) {
        context.response.write([
            '<html><head><meta charset="UTF-8"><style>',
            'body{font-family:Arial,sans-serif;padding:28px;background:#f6f8fb;color:#26323f}',
            '.box{background:#fff;border:1px solid #d8e0e8;border-radius:8px;padding:22px;max-width:720px}',
            'h2{color:#b42318;margin-top:0}pre{white-space:pre-wrap;background:#f2f4f7;padding:12px;border-radius:4px}',
            '</style></head><body><div class="box"><h2>',
            escapeHtml(title),
            '</h2><pre>',
            escapeHtml((lines || []).join('\n')),
            '</pre></div></body></html>'
        ].join(''));
    }

    function toIsoDate(value) {
        if (!value) {
            return '';
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
            return String(value);
        }

        var parsed = format.parse({
            value: value,
            type: format.Type.DATE
        });

        return [
            parsed.getFullYear(),
            pad2(parsed.getMonth() + 1),
            pad2(parsed.getDate())
        ].join('-');
    }

    function multiDefault(value) {
        return normalizeMulti(value).join('\u0005');
    }

    function normalizeMulti(value) {
        if (!value) {
            return [];
        }
        if (Array.isArray(value)) {
            return value.filter(Boolean).map(String);
        }

        return String(value)
            .split(/\u0005|\u0001|,/)
            .map(function (entry) {
                return entry.trim();
            })
            .filter(Boolean);
    }

    function safeDivide(numerator, denominator) {
        var denominatorNumber = toNumber(denominator);
        if (!denominatorNumber) {
            return null;
        }
        return toNumber(numerator) / denominatorNumber;
    }

    function toNumber(value) {
        var numberValue = Number(value);
        return isFinite(numberValue) ? numberValue : 0;
    }

    function round(value, decimals) {
        var factor = Math.pow(10, decimals || 2);
        return Math.round(toNumber(value) * factor) / factor;
    }

    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function excelNum(value) {
        var raw = excelNumber(value);
        var text = raw ? formatDecimal(value) : '';
        return '<td class="num" x:num="' + raw + '">' + escapeHtml(text) + '</td>';
    }

    function excelPct(value) {
        var raw = excelNumber(value);
        var text = raw ? formatPercent(value) : '';
        return '<td class="pct" x:num="' + raw + '">' + escapeHtml(text) + '</td>';
    }

    function excelNumber(value) {
        var numberValue = Number(value);
        return isFinite(numberValue) ? String(numberValue) : '';
    }

    function formatDecimal(value) {
        var numberValue = Number(value);
        if (!isFinite(numberValue)) {
            return '';
        }

        return numberValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function formatPercent(value) {
        var numberValue = Number(value);
        if (!isFinite(numberValue)) {
            return '';
        }

        return (numberValue * 100).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }) + '%';
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return {
        onRequest: onRequest
    };
});
