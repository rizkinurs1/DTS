/**
 * DTS IA vs COGS Comparison Report Suitelet.
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
    'N/search',
    'N/task',
    'N/ui/serverWidget'
], function (file, format, log, query, runtime, search, task, serverWidget) {
    var MR_SCRIPT_ID = 'customscript_dts_ia_cogs_comparison_mr';
    var MR_DEPLOYMENT_ID = 'customdeploy_dts_ia_cogs_comparison_mr';
    var OUTPUT_FOLDER_ID = '499';
    var ITEM_OPTION_LIMIT = 4000;

    var MR_PARAM_START_DATE = 'custscript_dts_iacogs_start_date';
    var MR_PARAM_END_DATE = 'custscript_dts_iacogs_end_date';
    var MR_PARAM_SUBSIDIARIES = 'custscript_dts_iacogs_subsidiaries';
    var MR_PARAM_ITEMS = 'custscript_dts_iacogs_items';
    var MR_PARAM_OUTPUT_FOLDER = 'custscript_dts_iacogs_mr_output_folder';
    var MR_PARAM_RUN_ID = 'custscript_dts_iacogs_run_id';

    function onRequest(context) {
        var params = context.request.parameters || {};
        var action = params.action || '';

        if (action === 'checkstatus') {
            checkStatus(context);
            return;
        }
        if (action === 'viewreport') {
            viewReport(context);
            return;
        }
        if (action === 'data') {
            writeData(context);
            return;
        }
        if (action === 'download') {
            downloadExcel(context);
            return;
        }

        if (context.request.method === 'POST') {
            submitReport(context);
            return;
        }

        writeForm(context, params);
    }

    function writeForm(context, params) {
        var form = serverWidget.createForm({
            title: 'DTS IA vs COGS Comparison Report'
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
            container: group.id
        });
        addSubsidiaryOptions(subsidiary, form);

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

    function submitReport(context) {
        var params = context.request.parameters || {};
        var startDate = toIsoDate(params.custpage_start_date);
        var endDate = toIsoDate(params.custpage_end_date);
        var subsidiaries = csvParam(params.custpage_subsidiary);
        var items = csvParam(params.custpage_item);
        var runId = buildRunId();

        var taskParams = {};
        taskParams[MR_PARAM_START_DATE] = startDate;
        taskParams[MR_PARAM_END_DATE] = endDate;
        taskParams[MR_PARAM_SUBSIDIARIES] = subsidiaries;
        taskParams[MR_PARAM_ITEMS] = items;
        taskParams[MR_PARAM_OUTPUT_FOLDER] = OUTPUT_FOLDER_ID;
        taskParams[MR_PARAM_RUN_ID] = runId;

        try {
            var mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: MR_SCRIPT_ID,
                deploymentId: MR_DEPLOYMENT_ID,
                params: taskParams
            });

            writeStatusPage(context, mrTask.submit(), runId);
        } catch (e) {
            log.error({
                title: 'Submit MR failed',
                details: e
            });
            writeErrorPage(context, 'Gagal submit Map/Reduce', [
                'Pastikan Map/Reduce script record sudah dibuat.',
                'Script ID: ' + MR_SCRIPT_ID,
                'Deployment ID: ' + MR_DEPLOYMENT_ID,
                'Error: ' + (e.message || e.name)
            ]);
        }
    }

    function checkStatus(context) {
        var params = context.request.parameters || {};
        var taskId = params.taskId || '';
        var runId = params.runId || '';
        var result = {
            status: 'PENDING',
            fileId: null,
            error: null
        };

        try {
            var status = task.checkStatus({ taskId: taskId });
            result.status = status.status;

            if (status.status === task.TaskStatus.COMPLETE) {
                var fileId = findResultJson(runId);
                if (fileId) {
                    result.fileId = fileId;
                } else {
                    result.status = 'FAILED';
                    result.error = 'MR selesai, tapi file JSON hasil report tidak ditemukan untuk runId ' + runId + '.';
                }
            } else if (status.status === task.TaskStatus.FAILED) {
                result.error = 'Map/Reduce gagal. Cek Script Execution Log untuk detail.';
            }
        } catch (e) {
            result.status = 'FAILED';
            result.error = 'Gagal cek status: ' + (e.message || e.name);
            log.error({
                title: 'Check status failed',
                details: e
            });
        }

        context.response.setHeader({
            name: 'Content-Type',
            value: 'application/json'
        });
        context.response.write(JSON.stringify(result));
    }

    function writeStatusPage(context, taskId, runId) {
        var baseUrl = getBaseUrl();
        var stageMap = JSON.stringify({
            PENDING: 'Menunggu antrian...',
            PROCESSING: 'Sedang memproses data...',
            COMPLETE: 'Report selesai.',
            FAILED: 'Proses gagal.'
        });

        context.response.write([
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>Generating Report</title>',
            '<style>',
            '*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f3f6f9;margin:0;',
            'min-height:100vh;display:flex;align-items:center;justify-content:center;color:#26323f}',
            '.card{background:#fff;width:min(540px,92vw);border:1px solid #d8e0e8;border-radius:8px;',
            'padding:34px;text-align:center;box-shadow:0 10px 30px rgba(20,40,70,.10)}',
            'h1{font-size:21px;color:#2f5496;margin:0 0 8px}.sub{font-size:12px;color:#758397;margin-bottom:24px}',
            '@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:48px;height:48px;border:5px solid #e1e8f0;',
            'border-top-color:#2f5496;border-radius:50%;margin:0 auto 20px;animation:spin .8s linear infinite}',
            '.stage{font-weight:bold;color:#2f5496;margin-bottom:8px}.status{font-size:14px;margin-bottom:8px}',
            '.elapsed{font-size:12px;color:#7b8794;margin-bottom:18px}.hide{display:none}',
            '.btn{display:inline-block;background:#2f5496;color:#fff;text-decoration:none;padding:11px 18px;',
            'border-radius:6px;margin:6px;font-size:13px}.btn.secondary{background:#fff;color:#2f5496;border:1px solid #2f5496}',
            '.done{color:#22863a;font-weight:bold}.fail{color:#b42318;font-weight:bold}.detail{font-size:12px;color:#667085}',
            '</style></head><body><div class="card">',
            '<h1>DTS IA vs COGS Comparison</h1>',
            '<div class="sub">Run ID: ', escapeHtml(runId), '</div>',
            '<div id="spinner" class="spinner"></div>',
            '<div id="stage" class="stage">Menunggu antrian...</div>',
            '<div id="status" class="status">Memulai proses...</div>',
            '<div id="elapsed" class="elapsed"></div>',
            '<div id="actions" class="hide">',
            '<a id="viewBtn" class="btn" href="#">View Report</a>',
            '<a id="downloadBtn" class="btn secondary" href="#">Download Excel</a>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Generate New Report</a>',
            '</div>',
            '<div id="errorBox" class="hide">',
            '<div id="errorTitle" class="fail"></div>',
            '<div id="errorDetail" class="detail"></div>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Kembali</a>',
            '</div>',
            '</div><script>',
            'var tid=', JSON.stringify(taskId), ';',
            'var runId=', JSON.stringify(runId), ';',
            'var base=', JSON.stringify(baseUrl), ';',
            'var stageMap=', stageMap, ';',
            'var started=Date.now();var done=false;',
            'function fmt(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60);s%=60;return m?m+"m "+s+"s":s+"s";}',
            'setInterval(function(){if(!done)document.getElementById("elapsed").textContent="Waktu berjalan: "+fmt(Date.now()-started);},1000);',
            'function fail(msg){done=true;document.getElementById("spinner").className="hide";document.getElementById("stage").className="hide";',
            'document.getElementById("status").className="hide";document.getElementById("errorTitle").textContent="Proses gagal";',
            'document.getElementById("errorDetail").textContent=msg||"Unknown error";document.getElementById("errorBox").className="";}',
            'function poll(){fetch(base+"&action=checkstatus&taskId="+encodeURIComponent(tid)+"&runId="+encodeURIComponent(runId))',
            '.then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})',
            '.then(function(d){var s=d.status||"PENDING";document.getElementById("stage").textContent=stageMap[s]||s;',
            'if(s==="COMPLETE"){done=true;document.getElementById("spinner").className="hide";',
            'document.getElementById("status").innerHTML="<span class=\\"done\\">Report selesai ("+fmt(Date.now()-started)+")</span>";',
            'document.getElementById("viewBtn").href=base+"&action=viewreport&fileId="+encodeURIComponent(d.fileId);',
            'document.getElementById("downloadBtn").href=base+"&action=download&fileId="+encodeURIComponent(d.fileId);',
            'document.getElementById("actions").className="";return;}',
            'if(s==="FAILED"){fail(d.error);return;}document.getElementById("status").textContent="Status: "+s;setTimeout(poll,5000);})',
            '.catch(function(){document.getElementById("status").textContent="Menunggu response server...";setTimeout(poll,8000);});}',
            'setTimeout(poll,2500);',
            '</script></body></html>'
        ].join(''));
    }

    function viewReport(context) {
        var fileId = context.request.parameters.fileId;
        if (!fileId) {
            writeErrorPage(context, 'File report tidak ditemukan', ['Parameter fileId kosong.']);
            return;
        }

        var baseUrl = getBaseUrl();
        var downloadUrl = baseUrl + '&action=download&fileId=' + encodeURIComponent(fileId);
        context.response.write([
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>DTS IA vs COGS Comparison</title>',
            '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/css/tabulator_bootstrap4.min.css">',
            '<script src="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/js/tabulator.min.js"></script>',
            '<style>',
            'body{font-family:Arial,sans-serif;margin:0;background:#f6f8fb;color:#26323f}.wrap{padding:18px 22px}',
            '.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}.title{font-size:20px;font-weight:bold;margin-right:auto}',
            '.btn{border:1px solid #2f5496;background:#2f5496;color:#fff;border-radius:5px;padding:8px 12px;text-decoration:none;cursor:pointer;font-size:13px}',
            '.btn.secondary{background:#fff;color:#2f5496}.meta{font-size:12px;color:#667789;margin-bottom:10px;line-height:1.7}',
            '#reportTable{background:#fff;border:1px solid #d9e0e8}.tabulator{font-size:12px}',
            '.tabulator .tabulator-col.base-head,.tabulator .tabulator-col.base-head .tabulator-col-content{background:#e7edf7!important}',
            '.tabulator .tabulator-col.avg-head,.tabulator .tabulator-col.avg-head .tabulator-col-content{background:#e8f3e3!important}',
            '.tabulator .tabulator-col.qty-head,.tabulator .tabulator-col.qty-head .tabulator-col-content{background:#e4eefb!important}',
            '.tabulator .tabulator-col.value-head,.tabulator .tabulator-col.value-head .tabulator-col-content{background:#f8e2e3!important}',
            '.tabulator .tabulator-col .tabulator-col-title{white-space:normal;text-overflow:clip;color:#1f2933}',
            '</style></head><body><div class="wrap">',
            '<div class="toolbar"><div class="title">DTS IA vs COGS Comparison</div>',
            '<a class="btn" href="', escapeHtml(downloadUrl), '">Download Excel</a>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Generate New Report</a></div>',
            '<div id="meta" class="meta">Loading report...</div><div id="reportTable"></div></div>',
            '<script>',
            'var fileId=', JSON.stringify(fileId), ',base=', JSON.stringify(baseUrl), ',rows=[];',
            'function n(v){return Number(v||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}',
            'function p(v){if(v===null||v===undefined||v==="")return "";return n(Number(v)*100)+"%";}',
            'fetch(base+"&action=data&fileId="+encodeURIComponent(fileId)).then(function(r){return r.json();}).then(function(payload){',
            'rows=payload.rows||[];var labels=payload.parameterLabels||{};',
            'document.getElementById("meta").textContent="Period: "+(labels.period||"-")+" | Subsidiary: "+(labels.subsidiary||"Semua")+" | Item: "+(labels.item||"Semua")+" | Rows: "+rows.length;',
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
            '}).catch(function(e){document.getElementById("meta").textContent="Failed to load report: "+e.message;});',
            '</script></body></html>'
        ].join(''));
    }

    function writeData(context) {
        var payload = addPayloadLabels(loadPayload(context.request.parameters.fileId));
        context.response.setHeader({
            name: 'Content-Type',
            value: 'application/json'
        });
        context.response.write(JSON.stringify(payload));
    }

    function downloadExcel(context) {
        try {
            var payload = addPayloadLabels(loadPayload(context.request.parameters.fileId));
            var reportFile = file.create({
                name: (payload.runId || 'dts_ia_cogs_comparison') + '.xls',
                fileType: file.Type.HTMLDOC,
                contents: buildExcelHtml(payload.rows || [], payload.parameterLabels)
            });

            context.response.writeFile({
                file: reportFile,
                isInline: false
            });
        } catch (e) {
            log.error({
                title: 'Download Excel failed',
                details: e
            });
            writeErrorPage(context, 'Gagal generate Excel', [e.message || e.name]);
        }
    }

    function addSubsidiaryOptions(field, form) {
        field.addSelectOption({
            value: '',
            text: ''
        });

        try {
            runPagedRows([
                'SELECT id, name',
                'FROM subsidiary',
                "WHERE NVL(isinactive, 'F') = 'F'",
                'ORDER BY name'
            ].join(' '), []).forEach(function (row) {
                field.addSelectOption({
                    value: String(row.id),
                    text: row.name || String(row.id)
                });
            });
        } catch (e) {
            log.error({
                title: 'Load subsidiary options failed',
                details: e
            });
            addMessage(form, 'Subsidiary option gagal dimuat. Kosongkan Subsidiary untuk proses semua subsidiary.');
        }
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

    function findResultJson(runId) {
        var fileId = null;

        search.create({
            type: 'file',
            filters: [
                ['name', 'contains', runId]
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'name' }),
                search.createColumn({ name: 'created', sort: search.Sort.DESC })
            ]
        }).run().each(function (result) {
            var name = result.getValue({ name: 'name' }) || '';
            if (/\.json$/i.test(name)) {
                fileId = result.getValue({ name: 'internalid' });
                return false;
            }
            return true;
        });

        return fileId;
    }

    function loadPayload(fileId) {
        if (!fileId) {
            throw new Error('fileId kosong.');
        }
        return JSON.parse(file.load({ id: fileId }).getContents());
    }

    function addPayloadLabels(payload) {
        var parameters = payload.parameters || {};
        payload.parameterLabels = {
            period: formatDisplayDate(parameters.startDate) + ' to ' + formatDisplayDate(parameters.endDate),
            subsidiary: getSelectedLabels(
                parameters.subsidiaries,
                'SELECT id, name AS label FROM subsidiary WHERE ',
                ' ORDER BY name'
            ),
            item: getSelectedLabels(
                parameters.items,
                'SELECT id, itemid AS label FROM item WHERE ',
                ' ORDER BY itemid'
            )
        };
        return payload;
    }

    function getSelectedLabels(values, sqlPrefix, sqlSuffix) {
        var ids = normalizeMulti(values);
        if (!ids.length) {
            return 'Semua';
        }

        var params = ids.map(function (value) {
            return Number(value);
        });
        var placeholders = ids.map(function () {
            return '?';
        }).join(', ');

        try {
            var labels = runPagedRows(sqlPrefix + 'id IN (' + placeholders + ')' + sqlSuffix, params).map(function (row) {
                return row.label || String(row.id);
            });
            return labels.length ? labels.join(', ') : ids.join(', ');
        } catch (e) {
            log.error({
                title: 'Load parameter labels failed',
                details: e
            });
            return ids.join(', ');
        }
    }

    function runPagedRows(sql, params) {
        var rows = [];
        var options = {
            query: sql,
            pageSize: 1000
        };
        if (params && params.length) {
            options.params = params;
        }
        var paged = query.runSuiteQLPaged(options);

        paged.pageRanges.forEach(function (range) {
            var page = paged.fetch({ index: range.index });
            rows = rows.concat(page.data.asMappedResults());
        });

        return rows;
    }

    function buildExcelHtml(rows, labels) {
        labels = labels || {};
        var html = [
            '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">',
            '<style>',
            'table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt}',
            'th,td{border:1px solid #9aa7b4;padding:4px 6px;white-space:nowrap}',
            'th{text-align:center;font-weight:bold;color:#1f2933}',
            '.report-title{background:#2f5496;color:#fff;font-size:16pt;text-align:left;padding:8px}',
            '.param-label{background:#e7edf7;font-weight:bold}.param-value{text-align:left}',
            '.spacer td{border:0;height:6px}',
            '.base{background:#e7edf7}.avg{background:#e8f3e3}.qty{background:#e4eefb}.val{background:#f8e2e3}',
            '.num{mso-number-format:"#,##0.00";text-align:right}.pct{mso-number-format:"0.00%";text-align:right}',
            '</style></head><body><table>',
            '<tr><th class="report-title" colspan="14">DTS IA vs COGS Comparison</th></tr>',
            '<tr><td class="param-label" colspan="2">Period</td><td class="param-value" colspan="12">',
            escapeHtml(labels.period || '-'), '</td></tr>',
            '<tr><td class="param-label" colspan="2">Subsidiary</td><td class="param-value" colspan="12">',
            escapeHtml(labels.subsidiary || 'Semua'), '</td></tr>',
            '<tr><td class="param-label" colspan="2">Item</td><td class="param-value" colspan="12">',
            escapeHtml(labels.item || 'Semua'), '</td></tr>',
            '<tr class="spacer"><td colspan="14"></td></tr>',
            '<tr>',
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
            '<div class="title">Submitting report...</div>',
            '<div class="sub">Please wait, Suitelet is starting the Map/Reduce task.</div>',
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

    function getBaseUrl() {
        var script = runtime.getCurrentScript();
        return '/app/site/hosting/scriptlet.nl?script=' + encodeURIComponent(script.id) + '&deploy=' + encodeURIComponent(script.deploymentId);
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

    function formatDisplayDate(value) {
        var parts = String(value || '').split('-');
        if (parts.length !== 3) {
            return value || '';
        }
        return [parts[2], parts[1], parts[0]].join('/');
    }

    function csvParam(value) {
        return normalizeMulti(value).join(',');
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

    function buildRunId() {
        var now = new Date();
        return [
            'iacogs',
            now.getFullYear(),
            pad2(now.getMonth() + 1),
            pad2(now.getDate()),
            pad2(now.getHours()),
            pad2(now.getMinutes()),
            pad2(now.getSeconds()),
            String(Math.floor(Math.random() * 10000))
        ].join('_');
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
        if (value === null || value === undefined || value === '') {
            return '';
        }

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
