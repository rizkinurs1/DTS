/**
 * DTS IA vs COGS Comparison Report Map/Reduce.
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
    'N/file',
    'N/log',
    'N/query',
    'N/runtime'
], function (file, log, query, runtime) {
    var PARAM_START_DATE = 'custscript_dts_iacogs_start_date';
    var PARAM_END_DATE = 'custscript_dts_iacogs_end_date';
    var PARAM_SUBSIDIARIES = 'custscript_dts_iacogs_subsidiaries';
    var PARAM_ITEMS = 'custscript_dts_iacogs_items';
    var PARAM_OUTPUT_FOLDER = 'custscript_dts_iacogs_mr_output_folder';
    var PARAM_RUN_ID = 'custscript_dts_iacogs_run_id';
    var DEFAULT_OUTPUT_FOLDER = '499';

    function getInputData() {
        return [
            { source: 'IA' },
            { source: 'COGS' }
        ];
    }

    function map(context) {
        var entry = JSON.parse(context.value);

        if (entry.source === 'IA') {
            emitIaRows(context);
            return;
        }

        if (entry.source === 'COGS') {
            emitCogsRows(context);
        }
    }

    function reduce(context) {
        var result = {
            itemId: context.key,
            item: '',
            displayName: '',
            stockUnit: '',
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

        context.values.forEach(function (value) {
            var row = JSON.parse(value);
            result.item = result.item || row.item || '';
            result.displayName = result.displayName || row.displayName || '';
            result.stockUnit = result.stockUnit || row.stockUnit || '';

            if (row.source === 'IA') {
                result.iaCostAverage += toNumber(row.costAverage);
                result.iaQty += toNumber(row.qty);
                result.iaCost += toNumber(row.amount);
            } else if (row.source === 'COGS') {
                result.cogsCostAverage += toNumber(row.costAverage);
                result.cogsQty += toNumber(row.qty);
                result.cogsCost += toNumber(row.amount);
            }
        });

        result.costAverageDifference = result.cogsCostAverage - result.iaCostAverage;
        result.costAveragePercentage = safeDivide(result.costAverageDifference, result.iaCostAverage);

        // IA rows are negative in the reference report, so screenshot parity uses IA + COGS.
        result.qtyDifference = result.iaQty + result.cogsQty;
        result.qtyPercentage = safeDivide(result.qtyDifference, result.iaQty);
        result.valueDifference = result.iaCost + result.cogsCost;

        roundReportRow(result);

        context.write({
            key: result.itemId,
            value: JSON.stringify(result)
        });
    }

    function summarize(summary) {
        var rows = [];

        summary.output.iterator().each(function (key, value) {
            rows.push(JSON.parse(value));
            return true;
        });

        rows.sort(function (a, b) {
            return String(a.item || '').localeCompare(String(b.item || ''));
        });

        logSummaryErrors(summary);
        saveOutputFiles(rows);
    }

    function emitIaRows(context) {
        var config = getConfig();
        var sqlParams = [config.startDate, config.endDate];
        var subsidiaryCondition = buildInCondition('tl.subsidiary', config.subsidiaries, sqlParams);
        var itemCondition = buildInCondition('i.id', config.items, sqlParams);
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

        runPaged(sql, sqlParams, function (row) {
            context.write({
                key: String(row.item_id),
                value: JSON.stringify({
                    source: 'IA',
                    item: row.item_code,
                    displayName: row.display_name,
                    stockUnit: row.stock_unit,
                    costAverage: row.cost_average,
                    qty: row.qty,
                    amount: row.amount
                })
            });
        });
    }

    function emitCogsRows(context) {
        var config = getConfig();
        var sqlParams = [config.startDate, config.endDate];
        var subsidiaryCondition = buildInCondition('h.custrecord_dts_subsidiary_pos', config.subsidiaries, sqlParams);
        var itemCondition = buildInCondition('i.id', config.items, sqlParams);
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

        runPaged(sql, sqlParams, function (row) {
            context.write({
                key: String(row.item_id),
                value: JSON.stringify({
                    source: 'COGS',
                    item: row.item_code,
                    displayName: row.display_name,
                    stockUnit: row.stock_unit,
                    costAverage: row.cost_average,
                    qty: row.qty,
                    amount: row.amount
                })
            });
        });
    }

    function getConfig() {
        var script = runtime.getCurrentScript();

        return {
            startDate: script.getParameter({ name: PARAM_START_DATE }),
            endDate: script.getParameter({ name: PARAM_END_DATE }),
            subsidiaries: splitIds(script.getParameter({ name: PARAM_SUBSIDIARIES })),
            items: splitIds(script.getParameter({ name: PARAM_ITEMS })),
            outputFolder: script.getParameter({ name: PARAM_OUTPUT_FOLDER }) || DEFAULT_OUTPUT_FOLDER,
            runId: script.getParameter({ name: PARAM_RUN_ID }) || buildFallbackRunId()
        };
    }

    function buildInCondition(fieldId, values, params) {
        if (!values || !values.length) {
            return '1 = 1';
        }

        values.forEach(function (value) {
            params.push(value);
        });

        return fieldId + ' IN (' + values.map(function () {
            return '?';
        }).join(', ') + ')';
    }

    function runPaged(sql, params, callback) {
        var paged = query.runSuiteQLPaged({
            query: sql,
            params: params,
            pageSize: 1000
        });

        paged.pageRanges.forEach(function (range) {
            var page = paged.fetch({ index: range.index });
            page.data.asMappedResults().forEach(callback);
        });
    }

    function saveOutputFiles(rows) {
        var config = getConfig();

        if (!config.outputFolder) {
            log.error({
                title: 'Output folder is missing',
                details: 'Set script parameter ' + PARAM_OUTPUT_FOLDER + ' with a File Cabinet folder internal ID.'
            });
            return;
        }

        var payload = {
            runId: config.runId,
            generatedAt: new Date().toISOString(),
            parameters: {
                startDate: config.startDate,
                endDate: config.endDate,
                subsidiaries: config.subsidiaries,
                items: config.items
            },
            rows: rows
        };

        var jsonFile = file.create({
            name: config.runId + '_ia_cogs_comparison.json',
            fileType: file.Type.JSON,
            contents: JSON.stringify(payload, null, 2),
            folder: Number(config.outputFolder)
        });

        var csvFile = file.create({
            name: config.runId + '_ia_cogs_comparison.csv',
            fileType: file.Type.CSV,
            contents: buildCsv(rows),
            folder: Number(config.outputFolder)
        });

        var jsonFileId = jsonFile.save();
        var csvFileId = csvFile.save();

        log.audit({
            title: 'DTS IA COGS Comparison output saved',
            details: {
                runId: config.runId,
                rowCount: rows.length,
                jsonFileId: jsonFileId,
                csvFileId: csvFileId
            }
        });
    }

    function buildCsv(rows) {
        var headers = [
            'Item',
            'Display Name',
            'Stock Unit',
            'IA Cost (Average)',
            'COGS Cost (Average)',
            'Difference',
            'Percentage',
            'IA Qty',
            'COGS Qty',
            'Difference Qty',
            'Percentage Qty',
            'IA Cost',
            'COGS Cost',
            'Difference Value'
        ];

        var lines = [headers.map(csvEscape).join(',')];

        rows.forEach(function (row) {
            lines.push([
                row.item,
                row.displayName,
                row.stockUnit,
                row.iaCostAverage,
                row.cogsCostAverage,
                row.costAverageDifference,
                row.costAveragePercentage,
                row.iaQty,
                row.cogsQty,
                row.qtyDifference,
                row.qtyPercentage,
                row.iaCost,
                row.cogsCost,
                row.valueDifference
            ].map(csvEscape).join(','));
        });

        return lines.join('\n');
    }

    function csvEscape(value) {
        var text = value === null || value === undefined ? '' : String(value);
        if (/[",\n\r]/.test(text)) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    function splitIds(value) {
        if (!value) {
            return [];
        }

        return String(value)
            .split(/\u0005|,/)
            .map(function (entry) {
                return entry.trim();
            })
            .filter(Boolean)
            .map(function (entry) {
                var numeric = Number(entry);
                return isNaN(numeric) ? entry : numeric;
            });
    }

    function toNumber(value) {
        var numeric = Number(value);
        return isNaN(numeric) ? 0 : numeric;
    }

    function safeDivide(numerator, denominator) {
        var denominatorNumber = toNumber(denominator);
        if (!denominatorNumber) {
            return null;
        }
        return toNumber(numerator) / denominatorNumber;
    }

    function roundReportRow(row) {
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
    }

    function round(value, decimals) {
        var factor = Math.pow(10, decimals || 2);
        return Math.round(toNumber(value) * factor) / factor;
    }

    function logSummaryErrors(summary) {
        if (summary.inputSummary && summary.inputSummary.error) {
            log.error({ title: 'Input error', details: summary.inputSummary.error });
        }

        if (summary.mapSummary && summary.mapSummary.errors) {
            summary.mapSummary.errors.iterator().each(function (key, error) {
                log.error({ title: 'Map error ' + key, details: error });
                return true;
            });
        }

        if (summary.reduceSummary && summary.reduceSummary.errors) {
            summary.reduceSummary.errors.iterator().each(function (key, error) {
                log.error({ title: 'Reduce error ' + key, details: error });
                return true;
            });
        }
    }

    function buildFallbackRunId() {
        return 'iacogs_' + String(new Date().getTime());
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
