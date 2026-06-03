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
    'N/redirect',
    'N/runtime',
    'N/search',
    'N/task',
    'N/ui/serverWidget'
], function (file, format, log, query, redirect, runtime, search, task, serverWidget) {
    var PARAM_MR_SCRIPT_ID = 'custscript_dts_iacogs_mr_script_id';
    var PARAM_MR_DEPLOY_ID = 'custscript_dts_iacogs_mr_deploy_id';
    var PARAM_OUTPUT_FOLDER = 'custscript_dts_iacogs_output_folder';

    var MR_PARAM_START_DATE = 'custscript_dts_iacogs_start_date';
    var MR_PARAM_END_DATE = 'custscript_dts_iacogs_end_date';
    var MR_PARAM_SUBSIDIARIES = 'custscript_dts_iacogs_subsidiaries';
    var MR_PARAM_ITEMS = 'custscript_dts_iacogs_items';
    var MR_PARAM_OUTPUT_FOLDER = 'custscript_dts_iacogs_mr_output_folder';
    var MR_PARAM_RUN_ID = 'custscript_dts_iacogs_run_id';

    var DEFAULT_MR_SCRIPT_ID = 'customscript_dts_ia_cogs_report_mr';
    var DEFAULT_MR_DEPLOY_ID = 'customdeploy_dts_ia_cogs_report_mr';
    var DEFAULT_OUTPUT_FOLDER = '499';
    var PREVIEW_LIMIT = 200;
    var ITEM_OPTION_LIMIT = 4000;

    function onRequest(context) {
        var params = context.request.parameters || {};
        var action = params.action || '';

        if (action === 'checkstatus') {
            checkStatus(context);
            return;
        }
        if (action === 'statuspage') {
            writeStatusPage(context, params.custpage_task_id || params.taskId, params.custpage_run_id || params.runId);
            return;
        }
        if (action === 'viewreport') {
            writeReportPage(context, params.fileId);
            return;
        }
        if (action === 'data') {
            writeReportData(context, params.fileId);
            return;
        }
        if (action === 'download') {
            downloadExcel(context, params.fileId);
            return;
        }

        if (context.request.method === 'POST') {
            submitReport(context);
            return;
        }

        renderForm(context, params);
    }

    function renderForm(context, requestParams) {
        var form = serverWidget.createForm({
            title: 'DTS IA vs COGS Comparison Report'
        });

        addParameterFields(form, requestParams);

        if (requestParams.custpage_task_id || requestParams.custpage_run_id) {
            addStatusPanel(form, requestParams);
        }

        form.addSubmitButton({
            label: 'Process Report'
        });

        context.response.writePage(form);
    }

    function addParameterFields(form, requestParams) {
        var filterGroup = form.addFieldGroup({
            id: 'custpage_filter_group',
            label: 'Report Parameters'
        });

        var startDate = form.addField({
            id: 'custpage_start_date',
            type: serverWidget.FieldType.DATE,
            label: 'Start Date',
            container: filterGroup.id
        });
        startDate.isMandatory = true;

        var endDate = form.addField({
            id: 'custpage_end_date',
            type: serverWidget.FieldType.DATE,
            label: 'End Date',
            container: filterGroup.id
        });
        endDate.isMandatory = true;

        var subsidiary = form.addField({
            id: 'custpage_subsidiary',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Subsidiary',
            source: 'subsidiary',
            container: filterGroup.id
        });

        var item = form.addField({
            id: 'custpage_item',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Item',
            container: filterGroup.id
        });
        addInventoryAndAssemblyOptions(item, form);

        if (requestParams.custpage_start_date) {
            startDate.defaultValue = requestParams.custpage_start_date;
        }
        if (requestParams.custpage_end_date) {
            endDate.defaultValue = requestParams.custpage_end_date;
        }
        if (requestParams.custpage_subsidiary) {
            subsidiary.defaultValue = toMultiSelectDefault(requestParams.custpage_subsidiary);
        }
        if (requestParams.custpage_item) {
            item.defaultValue = toMultiSelectDefault(requestParams.custpage_item);
        }
    }

    function addInventoryAndAssemblyOptions(itemField, form) {
        itemField.addSelectOption({
            value: '',
            text: ''
        });

        var sql = [
            'SELECT id, itemid, displayname',
            'FROM item',
            "WHERE itemtype IN ('InvtPart', 'Assembly')",
            "AND NVL(isinactive, 'F') = 'F'",
            'ORDER BY itemid'
        ].join(' ');

        try {
            var paged = query.runSuiteQLPaged({
                query: sql,
                pageSize: 1000
            });
            var count = 0;

            paged.pageRanges.some(function (range) {
                var page = paged.fetch({ index: range.index });
                page.data.asMappedResults().some(function (row) {
                    if (count >= ITEM_OPTION_LIMIT) {
                        return true;
                    }

                    itemField.addSelectOption({
                        value: String(row.id),
                        text: buildItemText(row)
                    });
                    count += 1;
                    return false;
                });

                return count >= ITEM_OPTION_LIMIT;
            });

            if (count >= ITEM_OPTION_LIMIT) {
                addInlineMessage(form, [
                    '<div class="uir-alert-box warning">',
                    'Item option list is limited to the first ',
                    ITEM_OPTION_LIMIT,
                    ' active Inventory/Assembly items. Leave Item blank to process all items.',
                    '</div>'
                ].join(''));
            }
        } catch (e) {
            log.error({
                title: 'Failed to load item options',
                details: e
            });
            addInlineMessage(form, [
                '<div class="uir-alert-box warning">',
                'Item options could not be loaded. Leave Item blank to process all items, or retry after checking SuiteQL access.',
                '</div>'
            ].join(''));
        }
    }

    function submitReport(context) {
        var params = context.request.parameters || {};
        var startDate = toIsoDate(params.custpage_start_date);
        var endDate = toIsoDate(params.custpage_end_date);
        var subsidiaries = normalizeMultiSelect(params.custpage_subsidiary).join(',');
        var items = normalizeMultiSelect(params.custpage_item).join(',');
        var runId = buildRunId();

        var script = runtime.getCurrentScript();
        var outputFolder = script.getParameter({ name: PARAM_OUTPUT_FOLDER }) || DEFAULT_OUTPUT_FOLDER;
        var mrScriptId = script.getParameter({ name: PARAM_MR_SCRIPT_ID }) || DEFAULT_MR_SCRIPT_ID;
        var mrDeployId = script.getParameter({ name: PARAM_MR_DEPLOY_ID }) || DEFAULT_MR_DEPLOY_ID;

        if (!startDate || !endDate) {
            renderForm(context, params);
            return;
        }

        var taskParams = {};
        taskParams[MR_PARAM_START_DATE] = startDate;
        taskParams[MR_PARAM_END_DATE] = endDate;
        taskParams[MR_PARAM_SUBSIDIARIES] = subsidiaries;
        taskParams[MR_PARAM_ITEMS] = items;
        taskParams[MR_PARAM_OUTPUT_FOLDER] = outputFolder || '';
        taskParams[MR_PARAM_RUN_ID] = runId;

        var mrTask = task.create({
            taskType: task.TaskType.MAP_REDUCE,
            scriptId: mrScriptId,
            deploymentId: mrDeployId,
            params: taskParams
        });

        var taskId = mrTask.submit();

        redirect.toSuitelet({
            scriptId: script.id,
            deploymentId: script.deploymentId,
            parameters: {
                action: 'statuspage',
                custpage_start_date: params.custpage_start_date,
                custpage_end_date: params.custpage_end_date,
                custpage_subsidiary: subsidiaries,
                custpage_item: items,
                custpage_task_id: taskId,
                custpage_run_id: runId
            }
        });
    }

    function checkStatus(context) {
        var params = context.request.parameters || {};
        var taskId = params.taskId || params.custpage_task_id || '';
        var runId = params.runId || params.custpage_run_id || '';
        var result = {
            status: 'PENDING',
            fileId: null,
            error: null
        };

        try {
            if (taskId) {
                var taskStatus = task.checkStatus({ taskId: taskId });
                result.status = taskStatus.status || result.status;
            }

            if (result.status === task.TaskStatus.COMPLETE) {
                var jsonFile = findJsonFile(findResultFiles(runId));
                if (jsonFile) {
                    result.fileId = jsonFile.id;
                } else {
                    result.status = 'FAILED';
                    result.error = 'Map/Reduce completed, but the JSON result file was not found for run ID ' + runId + '.';
                }
            } else if (result.status === task.TaskStatus.FAILED) {
                result.error = 'Map/Reduce task failed. Please check the Script Execution Log.';
            }
        } catch (e) {
            result.status = 'FAILED';
            result.error = 'Failed to check Map/Reduce status: ' + (e.message || e.name);
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
        var stageMapJson = JSON.stringify({
            PENDING: 'Waiting in queue...',
            PROCESSING: 'Processing data...',
            COMPLETE: 'Report is ready.',
            FAILED: 'Process failed.'
        });

        context.response.write([
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>Generating Report</title>',
            '<style>',
            '*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#eef2f6;',
            'display:flex;align-items:center;justify-content:center;min-height:100vh;color:#26323f}',
            '.card{width:min(560px,92vw);background:#fff;border:1px solid #d9e0e8;border-radius:8px;',
            'padding:34px 38px;text-align:center;box-shadow:0 12px 34px rgba(15,35,60,.10)}',
            'h1{font-size:22px;margin:0 0 8px;color:#203b5f}.sub{font-size:13px;color:#68788a;margin-bottom:28px}',
            '@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:48px;height:48px;border-radius:50%;',
            'border:5px solid #dfe6ee;border-top-color:#2f6fac;margin:0 auto 22px;animation:spin .8s linear infinite}',
            '.stage{font-weight:bold;color:#2f6fac;margin-bottom:8px}.status{font-size:14px;margin-bottom:8px}',
            '.elapsed{font-size:12px;color:#6d7b8c;margin-bottom:20px}.hide{display:none}',
            '.btn{display:inline-block;text-decoration:none;padding:11px 18px;border-radius:6px;border:1px solid #2f6fac;',
            'background:#2f6fac;color:#fff;margin:6px;font-size:13px}.btn.secondary{background:#fff;color:#2f6fac}',
            '.done{color:#1f7a4d;font-weight:bold}.fail{color:#b42318;font-weight:bold}.detail{font-size:12px;color:#738195}',
            '</style></head><body>',
            '<div class="card">',
            '<h1>DTS IA vs COGS Comparison</h1>',
            '<div class="sub">Run ID: ', escapeHtml(runId || '-'), '</div>',
            '<div id="spinner" class="spinner"></div>',
            '<div id="stage" class="stage">Waiting in queue...</div>',
            '<div id="status" class="status">Starting process...</div>',
            '<div id="elapsed" class="elapsed"></div>',
            '<div id="actions" class="hide">',
            '<a id="viewBtn" class="btn" href="#">View Report</a>',
            '<a id="downloadBtn" class="btn secondary" href="#">Download Excel</a>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Create New Report</a>',
            '</div>',
            '<div id="errorBox" class="hide">',
            '<div id="errorTitle" class="fail"></div>',
            '<div id="errorDetail" class="detail"></div>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Back</a>',
            '</div>',
            '</div>',
            '<script>',
            'var taskId=', JSON.stringify(taskId || ''), ';',
            'var runId=', JSON.stringify(runId || ''), ';',
            'var baseUrl=', JSON.stringify(baseUrl), ';',
            'var stageMap=', stageMapJson, ';',
            'var started=Date.now();var done=false;',
            'function fmt(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);s%=60;m%=60;',
            'if(h)return h+"h "+m+"m "+s+"s";if(m)return m+"m "+s+"s";return s+"s";}',
            'setInterval(function(){if(!done)document.getElementById("elapsed").textContent="Elapsed: "+fmt(Date.now()-started);},1000);',
            'function showError(msg){done=true;document.getElementById("spinner").className="hide";',
            'document.getElementById("stage").className="hide";document.getElementById("status").className="hide";',
            'document.getElementById("errorTitle").textContent="Process failed";',
            'document.getElementById("errorDetail").textContent=msg||"Unknown error.";document.getElementById("errorBox").className="";}',
            'function poll(){fetch(baseUrl+"&action=checkstatus&taskId="+encodeURIComponent(taskId)+"&runId="+encodeURIComponent(runId))',
            '.then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})',
            '.then(function(d){var s=d.status||"PENDING";document.getElementById("stage").textContent=stageMap[s]||s;',
            'if(s==="COMPLETE"){done=true;document.getElementById("spinner").className="hide";',
            'document.getElementById("status").innerHTML="<span class=\\"done\\">Report completed in "+fmt(Date.now()-started)+"</span>";',
            'document.getElementById("viewBtn").href=baseUrl+"&action=viewreport&fileId="+encodeURIComponent(d.fileId);',
            'document.getElementById("downloadBtn").href=baseUrl+"&action=download&fileId="+encodeURIComponent(d.fileId);',
            'document.getElementById("actions").className="";return;}',
            'if(s==="FAILED"){showError(d.error);return;}',
            'document.getElementById("status").textContent="Status: "+s;setTimeout(poll,5000);})',
            '.catch(function(e){document.getElementById("status").textContent="Waiting for server response...";setTimeout(poll,8000);});}',
            'setTimeout(poll,2500);',
            '</script></body></html>'
        ].join(''));
    }

    function writeReportData(context, fileId) {
        var payload = loadPayload(fileId);
        context.response.setHeader({
            name: 'Content-Type',
            value: 'application/json'
        });
        context.response.write(JSON.stringify(payload));
    }

    function writeReportPage(context, fileId) {
        if (!fileId) {
            context.response.write('<html><body><h2>Report file was not found.</h2></body></html>');
            return;
        }

        var baseUrl = getBaseUrl();

        context.response.write([
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>DTS IA vs COGS Comparison</title>',
            '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/css/tabulator_bootstrap4.min.css">',
            '<script src="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/tabulator-master/dist/js/tabulator.min.js"></script>',
            '<script src="https://cdn.jsdelivr.net/gh/diopputra/NS-Optimizer@master/script/libs/SheetJS/xlsx.full.min.js"></script>',
            '<style>',
            'body{font-family:Arial,sans-serif;margin:0;background:#f6f8fb;color:#26323f}.wrap{padding:18px 22px}',
            '.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}.title{font-size:20px;font-weight:bold;margin-right:auto}',
            '.btn{border:1px solid #2f6fac;background:#2f6fac;color:#fff;border-radius:5px;padding:8px 12px;text-decoration:none;cursor:pointer;font-size:13px}',
            '.btn.secondary{background:#fff;color:#2f6fac}.meta{font-size:12px;color:#667789;margin-bottom:10px}',
            '#reportTable{background:#fff;border:1px solid #d9e0e8}.tabulator{font-size:12px}',
            '.tabulator-col-group .tabulator-col-title{font-weight:bold}.avg-head{background:#e8f3e3!important}',
            '.qty-head{background:#e4eefb!important}.value-head{background:#f8e2e3!important}.base-head{background:#e7edf7!important}',
            '</style></head><body>',
            '<div class="wrap">',
            '<div class="toolbar">',
            '<div class="title">DTS IA vs COGS Comparison</div>',
            '<button id="xlsxBtn" class="btn">Download Excel</button>',
            '<a class="btn secondary" href="', escapeHtml(baseUrl), '">Create New Report</a>',
            '</div>',
            '<div id="meta" class="meta">Loading report...</div>',
            '<div id="reportTable"></div>',
            '</div>',
            '<script>',
            'var fileId=', JSON.stringify(fileId), ';',
            'var baseUrl=', JSON.stringify(baseUrl), ';',
            'var reportRows=[];var table=null;',
            'function n(v){return Number(v||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}',
            'function p(v){if(v===null||v===undefined||v==="")return "";return n(Number(v)*100)+"%";}',
            'function excelRows(rows){return rows.map(function(r){return {',
            '"Item":r.item,"Display Name":r.displayName,"Stock Unit":r.stockUnit,',
            '"IA Cost (Average)":r.iaCostAverage,"COGS Cost (Average)":r.cogsCostAverage,',
            '"Difference":r.costAverageDifference,"Percentage":r.costAveragePercentage,',
            '"IA Qty":r.iaQty,"COGS Qty":r.cogsQty,"Difference Qty":r.qtyDifference,"Percentage Qty":r.qtyPercentage,',
            '"IA Cost":r.iaCost,"COGS Cost":r.cogsCost,"Difference Value":r.valueDifference};});}',
            'function downloadXlsx(){var wb=XLSX.utils.book_new();var ws=XLSX.utils.json_to_sheet(excelRows(reportRows));',
            'XLSX.utils.book_append_sheet(wb,ws,"IA vs COGS");XLSX.writeFile(wb,"dts_ia_cogs_comparison.xlsx");}',
            'document.getElementById("xlsxBtn").onclick=downloadXlsx;',
            'fetch(baseUrl+"&action=data&fileId="+encodeURIComponent(fileId)).then(function(r){return r.json();}).then(function(payload){',
            'reportRows=payload.rows||[];document.getElementById("meta").textContent="Run ID: "+(payload.runId||"-")+" | Rows: "+reportRows.length;',
            'table=new Tabulator("#reportTable",{data:reportRows,layout:"fitDataStretch",height:"75vh",movableColumns:true,pagination:true,paginationSize:100,',
            'columns:[',
            '{title:"Item",field:"item",frozen:true,headerCssClass:"base-head"},',
            '{title:"Display Name",field:"displayName",headerCssClass:"base-head"},',
            '{title:"Stock Unit",field:"stockUnit",headerCssClass:"base-head"},',
            '{title:"Average Cost",headerCssClass:"avg-head",columns:[',
            '{title:"IA Cost (Average)",field:"iaCostAverage",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Cost (Average)",field:"cogsCostAverage",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference",field:"costAverageDifference",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"Percentage",field:"costAveragePercentage",hozAlign:"right",formatter:function(c){return p(c.getValue());}}]},',
            '{title:"Quantity",headerCssClass:"qty-head",columns:[',
            '{title:"IA Qty",field:"iaQty",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Qty",field:"cogsQty",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference Qty",field:"qtyDifference",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"Percentage",field:"qtyPercentage",hozAlign:"right",formatter:function(c){return p(c.getValue());}}]},',
            '{title:"Value",headerCssClass:"value-head",columns:[',
            '{title:"IA Cost",field:"iaCost",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"COGS Cost",field:"cogsCost",hozAlign:"right",formatter:function(c){return n(c.getValue());}},',
            '{title:"Difference Value",field:"valueDifference",hozAlign:"right",formatter:function(c){return n(c.getValue());}}]}',
            ']});',
            '}).catch(function(e){document.getElementById("meta").textContent="Failed to load report: "+e.message;});',
            '</script></body></html>'
        ].join(''));
    }

    function downloadExcel(context, fileId) {
        try {
            var payload = loadPayload(fileId);
            var excelFile = file.create({
                name: (payload.runId || 'dts_ia_cogs_comparison') + '.xls',
                fileType: file.Type.HTMLDOC,
                contents: buildExcelHtml(payload.rows || [])
            });
            context.response.writeFile({
                file: excelFile,
                isInline: false
            });
        } catch (e) {
            log.error({
                title: 'Excel download failed',
                details: e
            });
            context.response.write('<html><body><h2>Failed to generate Excel</h2><p>' + escapeHtml(e.message || e.name) + '</p></body></html>');
        }
    }

    function addStatusPanel(form, requestParams) {
        var taskId = requestParams.custpage_task_id || '';
        var runId = requestParams.custpage_run_id || '';
        var statusText = 'Not submitted';

        if (taskId) {
            try {
                var taskStatus = task.checkStatus({ taskId: taskId });
                statusText = taskStatus.status || statusText;
            } catch (e) {
                statusText = 'Unable to check task status: ' + escapeHtml(e.message || e.name);
            }
        }

        var resultFiles = runId ? findResultFiles(runId) : [];
        var jsonFile = findJsonFile(resultFiles);
        var rows = jsonFile ? loadRowsFromJson(jsonFile.id) : [];

        addInlineMessage(form, [
            '<style>',
            '.dts-report-panel{margin:14px 0;font-family:Arial,sans-serif;}',
            '.dts-report-status{padding:10px 12px;border:1px solid #d7dce2;background:#f7f9fb;margin-bottom:10px;}',
            '.dts-report-links a{display:inline-block;margin-right:12px;}',
            '.dts-report-table-wrap{max-height:620px;overflow:auto;border:1px solid #d7dce2;}',
            '.dts-report-table{border-collapse:collapse;width:100%;font-size:12px;}',
            '.dts-report-table th,.dts-report-table td{border:1px solid #d7dce2;padding:5px 7px;white-space:nowrap;}',
            '.dts-report-table th{position:sticky;top:0;z-index:1;color:#1f2933;}',
            '.dts-report-table th.group-base{background:#e7edf7;}',
            '.dts-report-table th.group-avg{background:#e8f3e3;}',
            '.dts-report-table th.group-qty{background:#e4eefb;}',
            '.dts-report-table th.group-value{background:#f8e2e3;}',
            '.dts-num{text-align:right;}',
            '</style>',
            '<div class="dts-report-panel">',
            '<div class="dts-report-status"><b>Run ID:</b> ', escapeHtml(runId || '-'),
            ' &nbsp; <b>Task ID:</b> ', escapeHtml(taskId || '-'),
            ' &nbsp; <b>Status:</b> ', escapeHtml(statusText), '</div>',
            buildFileLinks(resultFiles),
            buildPreviewTable(rows),
            '</div>'
        ].join(''));
    }

    function findResultFiles(runId) {
        var files = [];

        try {
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
                var id = result.getValue({ name: 'internalid' });
                var loaded = file.load({ id: id });
                files.push({
                    id: id,
                    name: result.getValue({ name: 'name' }),
                    url: loaded.url || ''
                });
                return true;
            });
        } catch (e) {
            log.error({
                title: 'Failed to find result files',
                details: e
            });
        }

        return files;
    }

    function buildFileLinks(files) {
        if (!files.length) {
            return '<div class="dts-report-links">Result file is not available yet. Refresh this page after the Map/Reduce completes.</div>';
        }

        var links = files.map(function (resultFile) {
            return [
                '<a href="', escapeHtml(resultFile.url), '" target="_blank">',
                escapeHtml(resultFile.name),
                '</a>'
            ].join('');
        });

        return '<div class="dts-report-links">' + links.join('') + '</div>';
    }

    function buildPreviewTable(rows) {
        if (!rows || !rows.length) {
            return '';
        }

        var previewRows = rows.slice(0, PREVIEW_LIMIT);
        var html = [
            '<div class="dts-report-table-wrap"><table class="dts-report-table"><thead><tr>',
            '<th class="group-base">Item</th>',
            '<th class="group-base">Display Name</th>',
            '<th class="group-base">Stock Unit</th>',
            '<th class="group-avg">IA Cost (Average)</th>',
            '<th class="group-avg">COGS Cost (Average)</th>',
            '<th class="group-avg">Difference</th>',
            '<th class="group-avg">Percentage</th>',
            '<th class="group-qty">IA Qty</th>',
            '<th class="group-qty">COGS Qty</th>',
            '<th class="group-qty">Difference Qty</th>',
            '<th class="group-qty">Percentage</th>',
            '<th class="group-value">IA Cost</th>',
            '<th class="group-value">COGS Cost</th>',
            '<th class="group-value">Difference Value</th>',
            '</tr></thead><tbody>'
        ];

        previewRows.forEach(function (row) {
            html.push('<tr>');
            html.push('<td>', escapeHtml(row.item || ''), '</td>');
            html.push('<td>', escapeHtml(row.displayName || ''), '</td>');
            html.push('<td>', escapeHtml(row.stockUnit || ''), '</td>');
            html.push(numCell(row.iaCostAverage));
            html.push(numCell(row.cogsCostAverage));
            html.push(numCell(row.costAverageDifference));
            html.push(percentCell(row.costAveragePercentage));
            html.push(numCell(row.iaQty));
            html.push(numCell(row.cogsQty));
            html.push(numCell(row.qtyDifference));
            html.push(percentCell(row.qtyPercentage));
            html.push(numCell(row.iaCost));
            html.push(numCell(row.cogsCost));
            html.push(numCell(row.valueDifference));
            html.push('</tr>');
        });

        html.push('</tbody></table></div>');

        if (rows.length > PREVIEW_LIMIT) {
            html.push('<div>Showing first ', PREVIEW_LIMIT, ' rows of ', rows.length, ' rows.</div>');
        }

        return html.join('');
    }

    function loadRowsFromJson(fileId) {
        try {
            var contents = file.load({ id: fileId }).getContents();
            var parsed = JSON.parse(contents);
            return parsed.rows || [];
        } catch (e) {
            log.error({
                title: 'Failed to load JSON preview',
                details: e
            });
            return [];
        }
    }

    function findJsonFile(files) {
        for (var i = 0; i < files.length; i += 1) {
            if (/\.json$/i.test(files[i].name || '')) {
                return files[i];
            }
        }
        return null;
    }

    function loadPayload(fileId) {
        if (!fileId) {
            throw new Error('Report file ID is required.');
        }

        var contents = file.load({ id: fileId }).getContents();
        return JSON.parse(contents);
    }

    function getBaseUrl() {
        var script = runtime.getCurrentScript();
        return [
            '/app/site/hosting/scriptlet.nl?script=',
            encodeURIComponent(script.id),
            '&deploy=',
            encodeURIComponent(script.deploymentId)
        ].join('');
    }

    function buildExcelHtml(rows) {
        var style = [
            '<style>',
            'table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt}',
            'th,td{border:1px solid #9aa7b4;padding:4px 6px;white-space:nowrap}',
            '.base{background:#e7edf7;font-weight:bold}',
            '.avg{background:#e8f3e3;font-weight:bold}',
            '.qty{background:#e4eefb;font-weight:bold}',
            '.value{background:#f8e2e3;font-weight:bold}',
            '.num{mso-number-format:"#,##0.00";text-align:right}',
            '.pct{mso-number-format:"0.00%";text-align:right}',
            '</style>'
        ].join('');

        var html = [
            '<html xmlns:x="urn:schemas-microsoft-com:office:excel">',
            '<head><meta charset="UTF-8">', style, '</head><body>',
            '<table>',
            '<tr>',
            '<th class="base">Item</th>',
            '<th class="base">Display Name</th>',
            '<th class="base">Stock Unit</th>',
            '<th class="avg">IA Cost (Average)</th>',
            '<th class="avg">COGS Cost (Average)</th>',
            '<th class="avg">Difference</th>',
            '<th class="avg">Percentage</th>',
            '<th class="qty">IA Qty</th>',
            '<th class="qty">COGS Qty</th>',
            '<th class="qty">Difference Qty</th>',
            '<th class="qty">Percentage</th>',
            '<th class="value">IA Cost</th>',
            '<th class="value">COGS Cost</th>',
            '<th class="value">Difference Value</th>',
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

    function excelNum(value) {
        if (value === null || value === undefined || value === '') {
            return '<td class="num"></td>';
        }
        return '<td class="num" x:num="' + escapeHtml(toExcelNumber(value)) + '">' + escapeHtml(toExcelNumber(value)) + '</td>';
    }

    function excelPct(value) {
        if (value === null || value === undefined || value === '') {
            return '<td class="pct"></td>';
        }
        return '<td class="pct" x:num="' + escapeHtml(toExcelNumber(value)) + '">' + escapeHtml(toExcelNumber(value)) + '</td>';
    }

    function toExcelNumber(value) {
        var numberValue = Number(value);
        return isFinite(numberValue) ? String(numberValue) : '';
    }

    function addInlineMessage(form, html) {
        var field = form.addField({
            id: 'custpage_msg_' + String(Math.floor(Math.random() * 1000000)),
            type: serverWidget.FieldType.INLINEHTML,
            label: 'Message'
        });
        field.defaultValue = html;
    }

    function buildItemText(row) {
        var parts = [row.itemid || row.id];
        if (row.displayname) {
            parts.push(row.displayname);
        }
        return parts.join(' - ');
    }

    function normalizeMultiSelect(value) {
        if (!value) {
            return [];
        }
        if (Array.isArray(value)) {
            return value.filter(Boolean).map(String);
        }

        return String(value)
            .split(/\u0005|,/)
            .map(function (entry) {
                return entry.trim();
            })
            .filter(Boolean);
    }

    function toMultiSelectDefault(value) {
        return normalizeMultiSelect(value).join('\u0005');
    }

    function toIsoDate(value) {
        if (!value) {
            return '';
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
            return String(value);
        }

        try {
            var parsed = format.parse({
                value: value,
                type: format.Type.DATE
            });

            if (parsed && !isNaN(parsed.getTime())) {
                return [
                    parsed.getFullYear(),
                    pad2(parsed.getMonth() + 1),
                    pad2(parsed.getDate())
                ].join('-');
            }
        } catch (e) {
            log.error({
                title: 'Date parse failed',
                details: e
            });
        }

        return String(value);
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

    function numCell(value) {
        return '<td class="dts-num">' + escapeHtml(formatNumber(value)) + '</td>';
    }

    function percentCell(value) {
        if (value === null || value === undefined || value === '') {
            return '<td class="dts-num"></td>';
        }
        return '<td class="dts-num">' + escapeHtml(formatNumber(Number(value) * 100)) + '%</td>';
    }

    function formatNumber(value) {
        if (value === null || value === undefined || value === '') {
            return '';
        }

        var numberValue = Number(value);
        if (!isFinite(numberValue)) {
            return String(value);
        }

        return numberValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
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
