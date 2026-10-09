
'use strict';

const SUPABASE_URL = 'https://vvvdtezgqscfbnljcdue.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_qyfMjuz-tav5i63Qpp1OeQ_hxCvvR0r';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let remoteReady = false, syncTimer = null, syncing = false, syncAgain = false;
const K = 'mfpm.v1', TYPES = ['Lumpsum', 'SIP', 'SWP', 'Redemption', 'Switch-In', 'Switch-Out'], OUT = ['SWP', 'Redemption', 'Switch-Out'];
const TABS = [['dash', 'Dashboard'], ['hold', 'Holdings'], ['tx', 'Transactions'], ['sip', 'SIP / SWP'], ['nav', 'NAV'], ['imp', 'Import']];
let S = JSON.parse(localStorage.getItem(K) || 'null') || { funds: [], txns: [], sips: [], navs: {}, ran: {} }, tab = 'dash', pend = [], seq = 0, autoSeq = 0;

const $ = s => document.querySelector(s), m = (a, f) => a.map(f).join('');

function save() {
    localStorage.setItem(K, JSON.stringify(S));
    if (remoteReady) queueRemoteSync();
}

const inr = n => (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const n4 = n => (+n).toLocaleString('en-IN', { maximumFractionDigits: 4 });
const pc = n => n == null ? '—' : (n * 100).toFixed(2) + '%';
const cl = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
const iso = d => d.toISOString().slice(0, 10);
const fs = v => String(v ?? '').replace(/\.0$/, '').trim();
const PF = () => $('#pf').value;
const today = () => iso(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4));

const tbl = (h, r) => `<div class="tw"><table><thead><tr>${m(h, x => `<th>${x}</th>`)}</tr></thead><tbody>${m(r, x => `<tr>${m(x, c => `<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
const span = (v, t) => `<span class="${cl(v)}">${t}</span>`;

function toast(t) {
    const e = $('#toast');
    e.textContent = t;
    e.className = 'show';
    setTimeout(() => e.className = '', 3500);
}

function toISO(v) {
    // Handles Date, Excel serial, YYYY-MM-DD and DD-MM-YYYY.
    if (v instanceof Date) return iso(new Date(v.getTime() + 432e5));
    if (typeof v === 'number') return iso(new Date(Math.round((v - 25569) * 864e5) + 432e5));

    const s = String(v || '').trim();
    let x;

    if (x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))
        return `${x[1]}-${x[2].padStart(2, '0')}-${x[3].padStart(2, '0')}`;

    if (x = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/))
        return `${x[3]}-${x[2].padStart(2, '0')}-${x[1].padStart(2, '0')}`;

    return null;
}

/* ---------- NAV (mfapi.in) ---------- */

const hist = {};

async function history(c) {
    if (!hist[c]) {
        const r = await fetch('https://api.mfapi.in/mf/' + c);
        if (!r.ok) throw Error(r.status);

        hist[c] = ((await r.json()).data || []).map(x => ({
            d: toISO(x.date),
            n: parseFloat(x.nav)
        }));
    }

    return hist[c];
}

async function navOn(c, date) {
    const e = (await history(c)).find(x => x.d <= date);
    return e ? e.n : null;
}

async function refreshNav() {
    const codes = [...new Set(S.funds.map(f => f.code))];
    let ok = 0;

    await Promise.all(codes.map(async c => {
        try {
            const h = await history(c);
            if (h.length) {
                S.navs[c] = {
                    latest: h[0].n,
                    prev: (h[1] || h[0]).n,
                    date: h[0].d
                };
                ok++;
            }
        } catch (e) {
            console.warn(c, e);
        }
    }));

    S.navAt = today();
    save();
    toast(`NAV updated for ${ok}/${codes.length} schemes`);
    render();
}

/* ---------- MATHS ---------- */

const pfOf = (fo, c) =>
    (S.funds.find(f => f.folio === fo && f.code === c) ||
        S.funds.find(f => f.folio === fo) || {}).portfolio || '—';

function xirr(keys, val) {
    const cf = S.txns
        .filter(t => keys.has(t.folio + '|' + t.code) && t.amount)
        .map(t => [new Date(t.date), -t.amount]);

    cf.push([new Date(), val]);

    const t0 = Math.min(...cf.map(c => c[0]));
    const f = r => cf.reduce(
        (s, [d, a]) => s + a / Math.pow(1 + r, (d - t0) / 31536e6),
        0
    );

    let lo = -.99, hi = 10;
    if (!(f(lo) * f(hi) < 0)) return null;

    for (let i = 0; i < 80; i++) {
        const q = (lo + hi) / 2;
        f(lo) * f(q) <= 0 ? hi = q : lo = q;
    }

    return (lo + hi) / 2;
}

function hold() {
    const mp = {};

    S.funds.forEach(f => {
        mp[f.folio + '|' + f.code] = { ...f, units: 0, inv: 0 };
    });

    const txns = [...S.txns].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    );

    txns.forEach(t => {
        const h = mp[t.folio + '|' + t.code] ||
            (mp[t.folio + '|' + t.code] = {
                folio: t.folio,
                code: t.code,
                name: t.name,
                portfolio: pfOf(t.folio, t.code),
                units: 0,
                inv: 0
            });

        if (t.units > 0) {
            h.inv += t.amount;
            h.units += t.units;
        } else if (t.units < 0) {
            h.inv += t.units * (h.units > 0 ? h.inv / h.units : 0);
            h.units += t.units;
        }
    });

    return Object.values(mp)
        .filter(h =>
            (!PF() || h.portfolio === PF()) &&
            (h.units > 1e-4 || Math.abs(h.inv) > 1)
        )
        .map(h => {
            const n = S.navs[h.code] || {};

            h.nav = n.latest || 0;
            h.prev = n.prev || h.nav;
            h.val = h.units * h.nav;
            h.d1 = h.units * (h.nav - h.prev);
            h.gain = h.val - h.inv;
            h.ret = h.inv > 0 ? h.gain / h.inv : 0;
            h.xirr = xirr(new Set([h.folio + '|' + h.code]), h.val);

            return h;
        });
}

function agg(r) {
    const inv = sum(r, 'inv');
    const val = sum(r, 'val');
    const d1 = sum(r, 'd1');

    return {
        inv,
        val,
        d1,
        d1p: val - d1 ? d1 / (val - d1) : 0,
        gain: val - inv,
        ret: inv > 0 ? (val - inv) / inv : 0,
        xirr: xirr(new Set(r.map(h => h.folio + '|' + h.code)), val)
    };
}

/* ---------- TRANSACTIONS ---------- */

function nextId(prefix = 'TXN') {
    if (prefix === 'AUTO') {
        if (!autoSeq) {
            autoSeq = Math.max(
                0,
                ...S.txns.map(t => +(t.id.match(/^AUTO(\d{1,5})$/) || [0, 0])[1])
            );
        }
        return 'AUTO' + String(++autoSeq).padStart(2, '0');
    }

    if (!seq) {
        seq = Math.max(
            0,
            ...S.txns.map(t => +(t.id.match(/^TXN(\d{1,5})$/) || [0, 0])[1])
        );
    }

    return 'TXN' + String(++seq).padStart(3, '0');
}

function mk(o) {
    const out = OUT.includes(o.type);
    const a = Math.abs(o.amount) * (out ? -1 : 1);
    const f = S.funds.find(f => f.code == o.code && f.folio == o.folio) || {};

    return {
        id: o.id || nextId(),
        date: o.date,
        code: +o.code,
        name: f.name || o.name || '',
        amc: f.amc || '',
        type: o.type,
        amount: a,
        nav: o.nav,
        units: +(o.units
            ? Math.abs(o.units) * (out ? -1 : 1)
            : a / o.nav
        ).toFixed(4),
        folio: o.folio,
        status: o.status || 'Completed'
    };
}

async function addTx(e) {
    e.preventDefault();

    const f = S.funds[+$('#ff').value];
    const date = $('#fd').value;
    let nav = +$('#fn').value;

    if (!nav) {
        try {
            nav = await navOn(f.code, date);
        } catch { }
    }

    if (!nav) return toast('NAV not found — enter it manually');

    S.txns.push(mk({
        date,
        code: f.code,
        folio: f.folio,
        type: $('#ft').value,
        amount: +$('#fa').value,
        nav
    }));

    save();
    render();
    toast('Transaction added');
}

function delTx(id) {
    if (confirm('Delete ' + id + '?')) {
        S.txns = S.txns.filter(t => t.id !== id);
        save();

        if (remoteReady) {
            sb.from('mf_transactions')
                .delete()
                .eq('transaction_id', id)
                .then(({ error }) => {
                    if (error) console.error('Supabase delete transaction:', error.message);
                });
        }

        render();
    }
}

/* ---------- SIP / SWP SCHEDULER ---------- */

async function runDue(manual) {
    let n = 0;
    const td = today();

    for (const s of S.sips.filter(s => s.active)) {
        const key = [s.folio, s.code, s.type, s.day].join('|');

        const last = S.txns
            .filter(t =>
                t.folio === s.folio &&
                t.code === s.code &&
                t.type === s.type
            )
            .map(t => t.date)
            .sort()
            .pop();

        const from = [S.ran[key], last].filter(Boolean).sort().pop();
        const d = new Date((from || td) + 'T12:00:00Z');
        let ok = true;

        if (from) d.setUTCDate(d.getUTCDate() + 1);

        for (; iso(d) <= td; d.setUTCDate(d.getUTCDate() + 1)) {
            const ld = new Date(
                Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
            ).getUTCDate();

            if (d.getUTCDate() !== Math.min(s.day, ld)) continue;

            let nav;
            try {
                nav = await navOn(s.code, iso(d));
            } catch { }

            nav = nav || (S.navs[s.code] || {}).latest;

            if (!nav) {
                ok = false;
                toast('NAV missing for ' + s.name);
                break;
            }

            S.txns.push(mk({
                id: nextId('AUTO'),
                date: iso(d),
                code: s.code,
                folio: s.folio,
                type: s.type,
                amount: s.amount,
                nav,
                status: 'Executed Automatically'
            }));

            n++;
        }

        if (ok) S.ran[key] = td;
    }

    save();

    if (n || manual) {
        toast(n ? `${n} SIP/SWP transaction(s) logged` : 'Nothing due');
    }

    render();
}

function addSip(e) {
    e.preventDefault();

    const f = S.funds[+$('#sf').value];

    S.sips.push({
        code: f.code,
        name: f.name,
        amc: f.amc,
        type: $('#st').value,
        day: +$('#sd').value,
        amount: +$('#sa').value,
        folio: f.folio,
        active: true
    });

    save();
    render();
}

const togSip = i => {
    S.sips[i].active = !S.sips[i].active;
    save();
    render();
};

const delSip = i => {
    if (confirm('Delete this schedule?')) {
        const old = S.sips[i];
        S.sips.splice(i, 1);
        save();

        if (remoteReady) {
            sb.from('mf_sip_schedules')
                .delete()
                .eq('schedule_id', sipId(old))
                .then(({ error }) => {
                    if (error) console.error('Supabase delete schedule:', error.message);
                });
        }

        render();
    }
};


/* ---------- EXCEL: WORKBOOK LOAD AND IMPORT ---------- */

async function loadWb(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const R = n => wb.Sheets[n]
        ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' })
        : [];

    S.funds = R('Funds')
        .filter(r => r['Scheme Code'])
        .map(r => ({
            folio: fs(r['Folio No']),
            portfolio: r['Portfolio ID'],
            code: +r['Scheme Code'],
            name: r['Scheme Name'],
            amc: r['AMC Name'],
            category: r.Category,
            distributor: r.Distributor || '',
            plan: r.Plan || '',
            option: r.Option || ''
        }));

    S.txns = R('Transactions')
        .filter(r => r['Scheme Code'] && r.Date)
        .map(r => {
            const type = typ(r.Type) || String(r.Type || '').trim();
            const out = OUT.includes(type);
            const amt = Math.abs(+r.Amount || 0) * (out ? -1 : 1);
            const nav = +r.NAV || 0;

            let unt = +r.Units;
            if (!unt && nav) unt = Math.abs(amt) / nav;
            unt = Math.abs(unt || 0) * (out ? -1 : 1);

            return {
                id: String(r['Transaction ID'] || nextId()),
                date: toISO(r.Date),
                code: +r['Scheme Code'],
                name: r['Scheme Name'],
                amc: r.AMC,
                type,
                amount: amt,
                nav,
                units: +unt.toFixed(4),
                folio: fs(r['Folio No']),
                status: r.Status
            };
        });

    S.sips = R('SIP')
        .filter(r => r['Scheme Code'])
        .map(r => ({
            code: +r['Scheme Code'],
            name: r['Scheme Name'],
            amc: r['AMC Name'],
            type: typ(r.Type) || String(r.Type || '').trim(),
            day: +r['SIP Date'],
            amount: Math.abs(+r.Amount),
            folio: fs(r['Folio No']),
            active:
                String(r.Active).trim().toUpperCase() === 'TRUE' ||
                String(r.Active).trim().toUpperCase() === 'YES' ||
                r.Active === true ||
                r.Active === 1
        }));

    S.navs = {};

    R('NAV_Data').forEach(r => {
        S.navs[+r['Scheme Code']] = {
            latest: +r['Latest NAV'],
            prev: +r['Previous NAV']
        };
    });

    S.ran = {};
    seq = 0;
    autoSeq = 0;
    save();

    toast(`Loaded ${S.funds.length} funds, ${S.txns.length} transactions, ${S.sips.length} SIP/SWP`);
    render();
    refreshNav();
}

const norm = k => String(k).toLowerCase().replace(/[^a-z]/g, '');
const sq = t => t.toLowerCase().replace(/[^a-z]/g, '');

const typ = v =>
    TYPES.find(t => sq(t) === norm(v)) ||
    ({
        purchase: 'Lumpsum',
        buy: 'Lumpsum',
        redeem: 'Redemption',
        sell: 'Redemption',
        withdrawal: 'SWP'
    })[norm(v)] ||
    null;

async function parseImp(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const raw = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]],
        { defval: '' }
    );

    pend = [];
    toast('Reading ' + raw.length + ' rows…');

    for (const [i, r0] of raw.entries()) {
        const r = {};
        for (const k in r0) r[norm(k)] = r0[k];

        const o = {
            row: i + 2,
            date: toISO(r.date),
            code: +r.schemecode,
            type: typ(r.type),
            amount: Math.abs(+r.amount),
            nav: +r.nav || 0,
            units: Math.abs(+r.units) || 0,
            folio: fs(r.foliono),
            pf: r.portfolioid,
            name: r.schemename,
            amc: r.amc,
            status: r.status,
            err: ''
        };

        if (!o.date) o.err = 'Bad date';
        else if (!o.code) o.err = 'No scheme code';
        else if (!o.type) o.err = 'Unknown type';
        else if (!(o.amount > 0)) o.err = 'Bad amount';

        if (!o.err && !o.folio) {
            const c = S.funds.filter(f => f.code === o.code);

            if (c.length === 1) o.folio = c[0].folio;
            else o.err = c.length
                ? 'Several folios — fill Folio No'
                : 'Unknown scheme — give Folio No + Portfolio ID';
        }

        if (!o.err &&
            !S.funds.some(f => f.code === o.code && f.folio === o.folio) &&
            !o.pf) {
            o.err = 'New fund — give Portfolio ID';
        }

        if (!o.err && !o.nav) {
            try {
                o.nav = await navOn(o.code, o.date) || 0;
            } catch { }

            if (!o.nav) o.err = 'NAV not found — fill NAV';
        }

        if (!o.err && S.txns.some(t =>
            t.date === o.date &&
            t.code === o.code &&
            t.folio === o.folio &&
            t.type === o.type &&
            Math.abs(Math.abs(t.amount) - o.amount) < .01
        )) {
            o.err = 'Duplicate — will skip';
        }

        pend.push(o);
    }

    render();
}

function commitImp() {
    let n = 0;

    for (const o of pend.filter(o => !o.err)) {
        if (!S.funds.some(f => f.code === o.code && f.folio === o.folio)) {
            S.funds.push({
                folio: o.folio,
                portfolio: o.pf,
                code: o.code,
                name: o.name || 'Scheme ' + o.code,
                amc: o.amc || '',
                category: ''
            });
        }

        S.txns.push(mk({ ...o, status: o.status || 'Imported' }));
        n++;
    }

    pend = [];
    save();
    tab = 'tx';
    location.hash = 'tx';
    toast(n + ' transactions imported');
    render();
}

function template() {
    const ws = XLSX.utils.json_to_sheet([{
        Date: '2024-05-07',
        'Scheme Code': 120833,
        'Scheme Name': '',
        AMC: '',
        Type: 'Lumpsum',
        Amount: 25000,
        'Folio No': '',
        Status: '',
        'Portfolio ID': ''
    }]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Past Transactions');
    XLSX.writeFile(wb, 'MF_Past_Transactions_Template.xlsx');
}

function templateFunds() {
    const ws = XLSX.utils.json_to_sheet([{
        Distributor: '',
        'Folio No': '',
        'Portfolio ID': '',
        'Scheme Code': 120833,
        'Scheme Name': '',
        'AMC Name': '',
        Plan: '',
        Option: '',
        Category: ''
    }]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Funds');
    XLSX.writeFile(wb, 'MF_Funds_Template.xlsx');
}

async function parseImpFunds(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const raw = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]],
        { defval: '' }
    );

    let n = 0, u = 0;

    for (const r0 of raw) {
        const r = {};
        for (const k in r0) r[norm(k)] = r0[k];

        const code = +r.schemecode;
        const folio = fs(r.foliono);

        if (!code || !folio) continue;

        const f = S.funds.find(x => x.code === code && x.folio === folio);

        if (f) {
            if (r.distributor) f.distributor = String(r0['Distributor'] || r.distributor);
            if (r.portfolioid) f.portfolio = fs(r0['Portfolio ID'] || r.portfolioid);
            if (r.schemename) f.name = String(r0['Scheme Name'] || r.schemename);
            if (r.amcname) f.amc = String(r0['AMC Name'] || r.amcname);
            if (r.plan) f.plan = String(r0['Plan'] || r.plan);
            if (r.option) f.option = String(r0['Option'] || r.option);
            if (r.category) f.category = String(r0['Category'] || r.category);
            u++;
        } else {
            S.funds.push({
                distributor: String(r0['Distributor'] || r.distributor || ''),
                folio,
                portfolio: fs(r0['Portfolio ID'] || r.portfolioid || ''),
                code,
                name: String(r0['Scheme Name'] || r.schemename || ''),
                amc: String(r0['AMC Name'] || r.amcname || ''),
                plan: String(r0['Plan'] || r.plan || ''),
                option: String(r0['Option'] || r.option || ''),
                category: String(r0['Category'] || r.category || '')
            });

            n++;
        }
    }

    save();
    toast(`${n} funds added, ${u} updated`);
    render();
}

function exportWb() {
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(S.funds.map(f => ({
            Distributor: f.distributor,
            'Folio No': f.folio,
            'Portfolio ID': f.portfolio,
            'Scheme Code': f.code,
            'Scheme Name': f.name,
            'AMC Name': f.amc,
            Plan: f.plan,
            Option: f.option,
            Category: f.category
        }))),
        'Funds'
    );

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(S.txns.map(t => ({
            'Transaction ID': t.id,
            Date: t.date,
            'Scheme Code': t.code,
            'Scheme Name': t.name,
            AMC: t.amc,
            Type: t.type,
            Amount: Math.abs(t.amount),
            NAV: t.nav,
            Units: Math.abs(t.units),
            'Folio No': t.folio,
            Status: t.status,
            'Portfolio ID': pfOf(t.folio, t.code)
        }))),
        'Transactions'
    );

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(S.sips.map(s => ({
            'Scheme Code': s.code,
            'Scheme Name': s.name,
            'AMC Name': s.amc,
            Type: s.type,
            'SIP Date': s.day,
            Amount: Math.abs(s.amount),
            'Folio No': s.folio,
            Active: s.active ? 'TRUE' : 'FALSE'
        }))),
        'SIP'
    );

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
            Object.entries(S.navs).map(([c, n]) => ({
                'Scheme Code': +c,
                'Latest NAV': n.latest,
                'Previous NAV': n.prev
            }))
        ),
        'NAV_Data'
    );

    XLSX.writeFile(wb, 'Main_Mutual_Fund_Portfolio_Manager_Export.xlsx');
}

/* ---------- VIEWS ---------- */

let txPage = 0, txFlt = {}, txSort = { k: 'date', d: -1 }, fltTimer;

function updFlt(k, v) {
    txFlt[k] = v;
    txPage = 0;
    clearTimeout(fltTimer);

    fltTimer = setTimeout(() => {
        render();

        setTimeout(() => {
            const el = $('#flt_' + k);
            if (el) {
                el.focus();
                if (el.selectionStart !== undefined) {
                    el.selectionStart = el.selectionEnd = el.value.length;
                }
            }
        }, 10);
    }, 300);
}

function setSort(k) {
    if (txSort.k === k) txSort.d *= -1;
    else txSort = { k, d: 1 };

    txPage = 0;
    render();
}

const fopts = () => m(
    S.funds,
    (f, i) => `<option value="${i}">${f.portfolio} · ${f.name} · ${f.folio}</option>`
);

const V = {
    dash() {
        const H = hold(), A = agg(H);
        const act = t => S.sips
            .filter(s =>
                s.active &&
                s.type === t &&
                (!PF() || pfOf(s.folio, s.code) === PF())
            )
            .reduce((a, s) => a + s.amount, 0);

        const pfs = [...new Set(H.map(h => h.portfolio))];
        const c = (l, v, k = '') =>
            `<div class="card"><small>${l}</small><b class="${k}">${v}</b></div>`;

        return `<div class="cards">${c('Net invested', inr(A.inv)) +
            c('Current value', inr(A.val)) +
            c('Gain / loss', inr(A.gain), cl(A.gain)) +
            c('Return', pc(A.ret), cl(A.ret)) +
            c('XIRR', pc(A.xirr), cl(A.xirr)) +
            c('1D change', inr(A.d1) + ' · ' + pc(A.d1p), cl(A.d1)) +
            c('Active SIP / month', inr(act('SIP'))) +
            c('Active SWP / month', inr(act('SWP')))
            }</div><h3>By portfolio</h3>` +
            tbl(
                ['Portfolio', 'Invested', 'Value', 'Gain / loss', 'Return', 'XIRR', '1D change'],
                pfs.map(p => {
                    const a = agg(H.filter(h => h.portfolio === p));
                    return [
                        p,
                        inr(a.inv),
                        inr(a.val),
                        span(a.gain, inr(a.gain)),
                        pc(a.ret),
                        pc(a.xirr),
                        span(a.d1, inr(a.d1) + ' (' + pc(a.d1p) + ')')
                    ];
                })
            );
    },

    hold() {
        return tbl(
            ['Portfolio', 'Scheme', 'Units', 'Avg NAV', 'NAV', '1D %', 'Invested', 'Value', 'P/L', 'Return', 'XIRR'],
            hold().sort((a, b) => b.val - a.val).map(h => [
                h.portfolio,
                `${h.name}<small>${h.folio}</small>`,
                n4(h.units),
                h.units > 0 ? (h.inv / h.units).toFixed(2) : '—',
                h.nav.toFixed(4),
                span(h.nav - h.prev, pc(h.prev ? (h.nav - h.prev) / h.prev : 0)),
                inr(h.inv),
                inr(h.val),
                span(h.gain, inr(h.gain)),
                span(h.ret, pc(h.ret)),
                pc(h.xirr)
            ])
        );
    },

    tx() {
        let r = S.txns.filter(t => !PF() || pfOf(t.folio, t.code) === PF());
        const fv = v => v != null ? String(v).toLowerCase() : '';

        r = r.filter(t => {
            if (txFlt.date && !fv(t.date).includes(fv(txFlt.date))) return false;
            if (txFlt.name && !fv(t.name).includes(fv(txFlt.name))) return false;
            if (txFlt.type && t.type !== txFlt.type) return false;
            if (txFlt.folio && !fv(t.folio).includes(fv(txFlt.folio))) return false;
            if (txFlt.portfolio && pfOf(t.folio, t.code) !== txFlt.portfolio) return false;
            return true;
        });

        r = r.sort((a, b) => {
            let va = a[txSort.k], vb = b[txSort.k];

            if (txSort.k === 'portfolio') {
                va = pfOf(a.folio, a.code);
                vb = pfOf(b.folio, b.code);
            }

            const cmp = typeof va === 'string'
                ? va.localeCompare(vb)
                : (va > vb ? 1 : va < vb ? -1 : 0);

            return cmp !== 0 ? cmp * txSort.d : b.id.localeCompare(a.id);
        });

        const sz = 50, pages = Math.ceil(r.length / sz);
        if (txPage >= pages) txPage = Math.max(0, pages - 1);

        const pd = r.slice(txPage * sz, (txPage + 1) * sz);

        const is = 'width:100%;min-width:60px;font-weight:normal;padding:4px;margin-top:4px;box-sizing:border-box';
        const stop = 'onclick="event.stopPropagation()"';

        const flds = [
            ['date', 'Date', `<input type="date" id="flt_date" style="${is}" value="${txFlt.date || ''}" onchange="updFlt('date', this.value)" ${stop}>`],
            ['name', 'Scheme', `<input id="flt_name" style="${is}" placeholder="a-z" value="${txFlt.name || ''}" oninput="updFlt('name', this.value)" ${stop}>`],
            ['type', 'Type', `<select id="flt_type" style="${is}" onchange="updFlt('type', this.value)" ${stop}><option value="">All</option>${m(TYPES, t => `<option ${txFlt.type === t ? 'selected' : ''}>${t}</option>`)}</select>`],
            ['amount', 'Amount', ''],
            ['nav', 'NAV', ''],
            ['units', 'Units', ''],
            ['folio', 'Folio', `<input id="flt_folio" style="${is}" placeholder="Folio" value="${txFlt.folio || ''}" oninput="updFlt('folio', this.value)" ${stop}>`],
            ['portfolio', 'Portfolio', `<select id="flt_portfolio" style="${is}" onchange="updFlt('portfolio', this.value)" ${stop}><option value="">All</option>${m([...new Set(S.funds.map(f => f.portfolio).filter(Boolean))], p => `<option ${txFlt.portfolio === p ? 'selected' : ''}>${p}</option>`)}</select>`],
            ['id', 'ID', '']
        ];

        const tblTx = `<div class="tw"><table><thead><tr>${m(flds, f => `<th style="cursor:pointer;vertical-align:top" onclick="setSort('${f[0]}')">${f[1]} ${txSort.k === f[0] ? (txSort.d === 1 ? '▲' : '▼') : ''}${f[2] ? '<br>' + f[2] : ''}</th>`)
            }<th></th></tr></thead><tbody>` +
            m(pd, t => `<tr><td>${t.date}</td><td>${t.name}</td><td>${t.type}</td><td>${span(t.amount, inr(t.amount))}</td><td>${t.nav}</td><td>${n4(t.units)}</td><td>${t.folio}</td><td>${pfOf(t.folio, t.code)}</td><td>${t.id}</td><td><button onclick="delTx('${t.id}')">✕</button></td></tr>`) +
            `</tbody></table></div>`;

        const pg = pages > 1 ? `<div class="row" style="align-items:center;margin-top:10px">
      <button onclick="txPage=0;render()" ${txPage === 0 ? 'disabled' : ''}>«</button>
      <button onclick="txPage--;render()" ${txPage === 0 ? 'disabled' : ''}>‹</button>
      <span class="muted" style="margin:0 10px">Page ${txPage + 1} of ${pages}</span>
      <button onclick="txPage++;render()" ${txPage === pages - 1 ? 'disabled' : ''}>›</button>
      <button onclick="txPage=${pages - 1};render()" ${txPage === pages - 1 ? 'disabled' : ''}>»</button>
    </div>` : '';

        return `<form class="row" onsubmit="addTx(event)"><input type="date" id="fd" value="${today()}" required><select id="ff">${fopts()}</select><select id="ft">${m(TYPES, t => `<option>${t}</option>`)}</select><input id="fa" type="number" step="0.01" min="0" placeholder="Amount ₹" required><input id="fn" type="number" step="0.0001" placeholder="NAV (auto if blank)"><button class="p">Add</button></form>` +
            tblTx + pg + `<p class="muted" style="margin-top:10px">Showing ${pd.length} of ${r.length} transactions (Total: ${S.txns.length})</p>`;
    },

    sip() {
        return `<form class="row" onsubmit="addSip(event)"><select id="sf">${fopts()}</select><select id="st"><option>SIP</option><option>SWP</option></select><input id="sd" type="number" min="1" max="31" placeholder="Day of month" required><input id="sa" type="number" step="0.01" min="0" placeholder="Amount ₹" required><button class="p">Add schedule</button></form>` +
            tbl(
                ['Active', 'Scheme', 'Type', 'Day', 'Amount', 'Folio', 'Portfolio', ''],
                S.sips.map((s, i) => [
                    `<input type="checkbox" ${s.active ? 'checked' : ''} onchange="togSip(${i})">`,
                    s.name,
                    s.type,
                    s.day,
                    span(s.type === 'SWP' ? -1 : 1, inr(s.amount)),
                    s.folio,
                    pfOf(s.folio, s.code),
                    `<button onclick="delSip(${i})">✕</button>`
                ]).filter((_, i) => !PF() || pfOf(S.sips[i].folio, S.sips[i].code) === PF())
            );
    },

    nav() {
        return tbl(
            ['Scheme code', 'Scheme', 'Latest NAV', 'Previous', 'Change', 'NAV date'],
            [...new Map(S.funds.map(f => [f.code, f])).values()].map(f => {
                const n = S.navs[f.code] || {};
                return [
                    f.code,
                    f.name,
                    n.latest || '—',
                    n.prev || '—',
                    n.latest ? span(n.latest - n.prev, pc((n.latest - n.prev) / n.prev)) : '—',
                    n.date || '—'
                ];
            })
        );
    },

    imp() {
        const ok = pend.filter(o => !o.err).length;

        return `<h3>Import past transactions from Excel / CSV</h3><p class="muted">Columns: <b>Date, Scheme Code, Type, Amount</b> — optional: Scheme Name, AMC, Folio No, Status, Portfolio ID. NAV is fetched and Units are calculated automatically. Blank Folio No works when the scheme has only one folio. Exact duplicates are skipped.</p>
  <div class="row"><button onclick="template()">⬇ Download template</button><label class="btn p">Choose file<input type="file" id="impf" accept=".xlsx,.xls,.csv" hidden></label>${pend.length ? `<button class="p" onclick="commitImp()" ${ok ? '' : 'disabled'}>Import ${ok} valid rows</button>` : ''}</div>` +
            (pend.length ? tbl(
                ['Row', 'Date', 'Scheme', 'Type', 'Amount', 'NAV', 'Folio', 'Result'],
                pend.map(o => [
                    o.row, o.date || '—', o.code || '—', o.type || '—',
                    o.amount || '—', o.nav || '—', o.folio || '—',
                    o.err ? `<span class="err">${o.err}</span>` : '<span class="pos">OK</span>'
                ])
            ) : '') +
            `<br><h3>Import funds from Excel / CSV</h3><p class="muted">Columns: <b>Distributor, Folio No, Portfolio ID, Scheme Code, Scheme Name, AMC Name, Plan, Option, Category</b></p>
  <div class="row"><button onclick="templateFunds()">⬇ Download template</button><label class="btn p">Choose file<input type="file" id="impFunds" accept=".xlsx,.xls,.csv" hidden></label></div>`;
    }
};

function render() {
    const pfs = [...new Set(S.funds.map(f => f.portfolio))];
    const cur = PF();

    $('#pf').innerHTML = '<option value="">All Portfolios</option>' +
        m(pfs, p => `<option${p === cur ? ' selected' : ''}>${p}</option>`);

    $('#tabs').innerHTML = m(
        TABS,
        ([k, l]) => `<a href="#${k}" class="${k === tab ? 'on' : ''}">${l}</a>`
    );

    $('#view').innerHTML = S.funds.length || tab === 'imp'
        ? V[tab]()
        : '<div class="empty"><h2>No data yet</h2><p>Click <b>Load workbook</b> and pick your Main_Mutual_Fund_Portfolio_Manager.xlsx</p></div>';

    const f = $('#impf');
    if (f) f.onchange = e => e.target.files[0] && parseImp(e.target.files[0]);

    const f2 = $('#impFunds');
    if (f2) f2.onchange = e => e.target.files[0] && parseImpFunds(e.target.files[0]);
}

$('#pf').onchange = render;
$('#bNav').onclick = refreshNav;
$('#bRun').onclick = () => runDue(true);
$('#bExp').onclick = exportWb;
$('#wb').onchange = e => e.target.files[0] && loadWb(e.target.files[0]);

onhashchange = () => {
    tab = TABS.some(t => t[0] === location.hash.slice(1))
        ? location.hash.slice(1)
        : 'dash';
    render();
};

tab = TABS.some(t => t[0] === location.hash.slice(1))
    ? location.hash.slice(1)
    : 'dash';



/* ---------- SUPABASE CLOUD DATABASE ---------- */

const sipId = s =>
    [s.folio, s.code, s.type, s.day]
        .map(v => String(v ?? '').replaceAll('|', '_'))
        .join('|');

function queueRemoteSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAllToSupabase, 700);
}

function asNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

async function loadRemoteData() {
    const [fr, tr, sr, nr] = await Promise.all([
        sb.from('mutual_funds').select('*'),
        sb.from('mf_transactions').select('*'),
        sb.from('mf_sip_schedules').select('*'),
        sb.from('mf_nav_data').select('*')
    ]);

    for (const r of [fr, tr, sr, nr]) {
        if (r.error) throw r.error;
    }

    const funds = fr.data || [];
    const txns = tr.data || [];
    const sips = sr.data || [];
    const navs = nr.data || [];

    // If the cloud is empty but this browser already has data,
    // preserve and upload the browser data.
    if (!funds.length && !txns.length && (S.funds.length || S.txns.length)) {
        remoteReady = true;
        await syncAllToSupabase(true);
        return;
    }

    if (funds.length || txns.length || sips.length || navs.length) {
        S.funds = funds.map(f => ({
            distributor: f.distributor || '',
            folio: fs(f.folio_no),
            portfolio: fs(f.portfolio_id),
            code: +f.scheme_code,
            name: f.scheme_name || '',
            amc: f.amc_name || '',
            plan: f.plan || '',
            option: f.option || '',
            category: f.category || ''
        }));

        S.txns = txns.map(t => {
            const type = typ(t.transaction_type) ||
                t.transaction_type || 'Lumpsum';

            const out = OUT.includes(type);
            const amount = Math.abs(asNumber(t.amount)) * (out ? -1 : 1);
            const units = Math.abs(asNumber(t.units)) * (out ? -1 : 1);

            return {
                id: String(t.transaction_id),
                date: toISO(t.transaction_date) ||
                    String(t.transaction_date).slice(0, 10),
                code: +t.scheme_code,
                name: t.scheme_name || '',
                amc: t.amc || '',
                type,
                amount,
                nav: asNumber(t.nav),
                units,
                folio: fs(t.folio_no),
                status: t.status || 'Completed'
            };
        });

        S.sips = sips.map(x => ({
            code: +x.scheme_code,
            name: x.scheme_name || '',
            amc: x.amc || '',
            type: x.schedule_type || 'SIP',
            day: +x.schedule_day,
            amount: Math.abs(asNumber(x.amount)),
            folio: fs(x.folio_no),
            active: x.active !== false
        }));

        S.navs = {};

        navs.forEach(n => {
            S.navs[+n.scheme_code] = {
                latest: asNumber(n.latest_nav),
                prev: asNumber(n.previous_nav),
                date: n.nav_date || ''
            };
        });

        S.ran = S.ran || {};
        localStorage.setItem(K, JSON.stringify(S));
    }

    remoteReady = true;
    render();
}

async function syncAllToSupabase(force = false) {
    if (!remoteReady && !force) return;

    if (syncing) {
        syncAgain = true;
        return;
    }

    syncing = true;

    try {
        if (S.funds.length) {
            const rows = S.funds.map(f => ({
                distributor: f.distributor || '',
                folio_no: fs(f.folio),
                portfolio_id: fs(f.portfolio),
                scheme_code: +f.code,
                scheme_name: f.name || '',
                amc_name: f.amc || '',
                plan: f.plan || '',
                option: f.option || '',
                category: f.category || ''
            }));

            const { error } = await sb
                .from('mutual_funds')
                .upsert(rows, { onConflict: 'folio_no,scheme_code' });

            if (error) throw error;
        }

        if (S.txns.length) {
            const rows = S.txns.map(t => ({
                transaction_id: String(t.id),
                transaction_date: t.date,
                scheme_code: +t.code,
                scheme_name: t.name || '',
                amc: t.amc || '',
                transaction_type: t.type,
                amount: Math.abs(asNumber(t.amount)),
                nav: asNumber(t.nav),
                units: Math.abs(asNumber(t.units)),
                folio_no: fs(t.folio),
                status: t.status || 'Completed'
            }));

            const { error } = await sb
                .from('mf_transactions')
                .upsert(rows, { onConflict: 'transaction_id' });

            if (error) throw error;
        }

        if (S.sips.length) {
            const rows = S.sips.map(x => ({
                schedule_id: sipId(x),
                scheme_code: +x.code,
                scheme_name: x.name || '',
                amc: x.amc || '',
                schedule_type: x.type,
                schedule_day: +x.day,
                amount: Math.abs(asNumber(x.amount)),
                folio_no: fs(x.folio),
                active: !!x.active
            }));

            const { error } = await sb
                .from('mf_sip_schedules')
                .upsert(rows, { onConflict: 'schedule_id' });

            if (error) throw error;
        }

        const navRows = Object.entries(S.navs || {}).map(([code, n]) => ({
            scheme_code: +code,
            latest_nav: asNumber(n.latest),
            previous_nav: asNumber(n.prev),
            nav_date: n.date || null,
            updated_at: new Date().toISOString()
        }));

        if (navRows.length) {
            const { error } = await sb
                .from('mf_nav_data')
                .upsert(navRows, { onConflict: 'scheme_code' });

            if (error) throw error;
        }

    } catch (e) {
        console.error('Supabase sync failed:', e.message || e);

        if (!force) {
            toast('Cloud sync failed: ' +
                (e.message || 'check Supabase tables / policies'));
        }

    } finally {
        syncing = false;

        if (syncAgain) {
            syncAgain = false;
            queueRemoteSync();
        }
    }
}

async function startApp() {
    render();

    try {
        await loadRemoteData();
        toast('Connected to Supabase');
    } catch (e) {
        console.error('Supabase connection/load failed:', e.message || e);
        toast('Supabase connection failed; using browser data');
    }

    if (S.funds.length) {
        if (S.navAt !== today()) await refreshNav();
        await runDue();
    }
}

startApp();
