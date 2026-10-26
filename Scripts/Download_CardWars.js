#!/usr/bin/env node
/**
 * Adventure Time Card Wars — base de cartes + images pour TCG Arena
 *
 * Sources : celles que l'auteur de carddweeb.com met à disposition des développeurs
 * (il demande explicitement de NE PAS scraper le site, son serveur est un projet perso) :
 *  - données : API JSON officielle  https://www.carddweeb.com/api/cards   (paginée, User-Agent obligatoire)
 *  - images  : dépôt GitHub          https://github.com/itderrickh/CardWarsImages   (scans PNG ~1500×2100)
 *    → les rares images absentes du dépôt sont prises sur carddweeb.com (URL fournie par l'API), une par une.
 *
 * Résultat (à la racine du dépôt) :
 *  - bdd.json            : toutes les cartes (dernière révision de chaque carte), triées par id carddweeb
 *  - Images/<set>/<id>.webp : images redimensionnées (750 px de large) en WebP, un sous-dossier par set
 *                         (code du set : cp1, ks1…, "NoSet" pour les cartes sans set)
 *  - Scripts/download-report.md : rapport (types, sets, images manquantes, erreurs…)
 *
 * Relancer le script ne retélécharge que les images nouvelles ou modifiées dans le dépôt GitHub.
 *
 * Variables d'environnement (toutes optionnelles) :
 *  FORCE=1           écrire bdd.json même si l'API renvoie beaucoup moins de cartes qu'avant
 *  REFRESH_IMAGES=1  retélécharger et reconvertir toutes les images
 *  SITE_IMAGES=0     ne jamais télécharger d'image depuis carddweeb.com (seulement GitHub)
 *  GITHUB_TOKEN      jeton GitHub (évite la limite de 60 appels/h de l'API GitHub, normalement inutile : 1 seul appel)
 *
 * Usage : node Scripts/Download_CardWars.js      (Node 18+, dépendance : npm install sharp)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// ─────────────────────────────── Configuration ───────────────────────────────

const trimSlash = s => String(s).replace(/\/+$/, '');

const CONFIG = {
    apiBase: trimSlash(process.env.API_BASE || 'https://www.carddweeb.com/api'),
    siteImagesBase: trimSlash(process.env.SITE_IMAGES_BASE || 'https://www.carddweeb.com/CardImages'),
    cardPageBase: 'https://www.carddweeb.com/Card?id=',
    githubApi: trimSlash(process.env.GITHUB_API || 'https://api.github.com'),
    githubRaw: trimSlash(process.env.GITHUB_RAW || 'https://raw.githubusercontent.com'),
    imagesRepo: 'itderrickh/CardWarsImages',
    imagesBranch: 'master',

    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),
    bddFile: 'bdd.json',
    imagesDir: 'Images',
    reportPath: path.join(__dirname, 'download-report.md'),

    pageSize: 100,              // maximum documenté par l'API
    apiDelayMs: 1000,           // pause entre deux pages de l'API
    githubConcurrency: 4,
    siteDelayMs: 1500,          // images prises sur carddweeb.com : une à la fois, avec une pause
    useSiteImages: process.env.SITE_IMAGES !== '0',

    // WebP q80 en 750 px : ~150 Ko/carte, meilleure qualité qu'un JPG q90 (~220 Ko) — mesuré sur les vrais scans
    maxWidth: 750,
    maxHeight: 1050,
    webpQuality: 80,

    timeoutMs: 120_000,
    retries: 3,
    minRatioVsPrevious: 0.8,    // sécurité : refuse d'écrire si l'API renvoie < 80 % des cartes déjà connues
    userAgent: 'TCG-Arena-AdventureTime-importer/1.0 (+https://valcur.github.io/TCG-Arena-AdventureTime)',
};

const FORCE = process.env.FORCE === '1';
const REFRESH_IMAGES = process.env.REFRESH_IMAGES === '1';

// Noms affichés par carddweeb (CornDome.Models/Cards/*.cs) — utilisés si l'API ne donne pas le libellé
const SET_NAMES = ['Finn Vs Jake', 'BMO Vs Lady Rainicorn', 'Princess Bubblegum Vs Lumpy Space Princess', 'Ice King Vs Marceline',
    'Lemon Grab Vs Gunter', 'Fionna Vs Cake', 'Doubles Tournament', 'Hero Pack', 'For The Glory', 'Promo', 'Kickstarter #1',
    'Flame Princess Vs Fern', 'Prismo Vs The Lich', 'Peppermint Butler Vs Magic Man', 'Kickstarter #2', 'DarkLands Expansion',
    'Custom Community Cards', 'Land of Legends', 'Kickstarter #3'];
const SET_CODES = ['cp1', 'cp2', 'cp3', 'cp4', 'cp5', 'cp6', '2v2', 'hp1', 'ftg', 'promo', 'ks1', 'cp7', 'cp8', 'cp9', 'ks2', 'dl1', 'custom', 'lol', 'ks3'];
const CARD_TYPES = ['Creature', 'Spell', 'Building', 'Landscape', 'Hero', 'Teamwork'];
const LANDSCAPES = ['Blue Plains', 'Cornfield', 'Useless Swamp', 'SandyLands', 'NiceLands', 'IcyLands', 'Rainbow', 'LavaFlats'];
// ordre de préférence des tailles d'image (CardImageTypeEnum : 0 XSmall, 1 Small, 2 Regular, 3 Large, 4 Optimized)
const IMAGE_SIZE_ORDER = [3, 2, 4, 1, 0];

// ─────────────────────────────── Rapport ───────────────────────────────

const issues = [];
function report(level, category, id, message) { issues.push({ level, category, id, message }); }

// ─────────────────────────────── Utilitaires ───────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = (...p) => path.join(CONFIG.repoRoot, ...p);
const clean = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stripExt = f => String(f).replace(/\.[a-z0-9]+$/i, '');
const decodeSafe = s => { try { return decodeURIComponent(s); } catch { return s; } };
const encodePath = p => String(p).split('/').map(seg => encodeURIComponent(decodeSafe(seg))).join('/');

/** Sous-dossier d'image d'une carte : code de son premier set (ex. "cp1"), "NoSet" pour les cartes sans set */
function setFolder(entry) {
    const raw = entry.setCodes?.find(Boolean) || entry.set || 'NoSet';
    return String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'NoSet';
}
const imagePathFor = entry => `${CONFIG.imagesDir}/${setFolder(entry)}/${entry.id}.webp`;

/** Clés JSON en camelCase quelle que soit la config du serveur (latestRevision / LatestRevision) */
const camel = o => Array.isArray(o) ? o.map(camel)
    : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), camel(v)]))
        : o;

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', content);
    await fsp.rename(file + '.tmp', file);
}

async function runPool(items, limit, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) await worker(items[i++]);
    }));
}

/** GET avec retries (réseau, 429, 5xx) → { ok, buffer, text, contentType } | { notFound, status } | { error } */
async function httpGet(url) {
    const headers = { 'User-Agent': CONFIG.userAgent };
    if (process.env.GITHUB_TOKEN && url.startsWith(CONFIG.githubApi)) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
            if (res.status === 404 || res.status === 410) { try { await res.body?.cancel(); } catch { } return { notFound: true, status: res.status }; }
            if (res.status === 429 || res.status >= 500) {
                try { await res.body?.cancel(); } catch { }
                lastError = `HTTP ${res.status}`;
                if (res.status === 429) await sleep(15_000);
            } else if (!res.ok) {
                let detail = '';
                try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' '); } catch { }
                return { error: `HTTP ${res.status}${detail ? ` (${detail})` : ''}`, status: res.status };
            } else {
                const buffer = Buffer.from(await res.arrayBuffer());
                return { ok: true, buffer, text: buffer.toString('utf8'), contentType: res.headers.get('content-type') || '' };
            }
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(3000 * 2 ** (attempt - 1));
    }
    return { error: lastError };
}

/** Requêtes vers carddweeb.com (hors API) : une seule à la fois, avec une pause */
let siteChain = Promise.resolve();
function siteGet(url) {
    const p = siteChain.then(async () => { const r = await httpGet(url); await sleep(CONFIG.siteDelayMs); return r; });
    siteChain = p.catch(() => { });
    return p;
}

// ─────────────────────────────── API carddweeb ───────────────────────────────

async function fetchAllCards() {
    const cards = new Map();
    let offset = 0, total = null, page = 0;
    for (; ;) {
        const url = `${CONFIG.apiBase}/cards?limit=${CONFIG.pageSize}&offset=${offset}`;
        const r = await httpGet(url);
        if (!r.ok) throw new Error(`${url} : ${r.error || 'HTTP ' + r.status}`);
        let body;
        try { body = camel(JSON.parse(r.text)); } catch { throw new Error(`${url} : réponse non JSON (${r.text.slice(0, 150)})`); }
        if (!Array.isArray(body.data)) throw new Error(`${url} : réponse inattendue, pas de tableau "data" (${r.text.slice(0, 150)})`);
        for (const c of body.data) if (c && c.id != null) cards.set(c.id, c);
        total = body.total ?? total;
        page++;
        process.stdout.write(`\r   page ${page} : ${cards.size}${total != null ? '/' + total : ''} cartes`);
        if (!body.next || !body.data.length) break; // "next" vide = dernière page
        offset += body.data.length;
        await sleep(CONFIG.apiDelayMs);
    }
    process.stdout.write('\n');
    if (total != null && cards.size < total) report('warning', 'API', '-', `${cards.size} cartes reçues alors que l'API en annonce ${total}`);
    return [...cards.values()];
}

/** Carte de l'API → entrée de bdd.json (+ liste des URLs d'image, de la plus grande à la plus petite) */
function normalizeCard(raw) {
    const revisions = Array.isArray(raw.revisions) ? raw.revisions : [];
    const rev = raw.latestRevision || [...revisions].sort((a, b) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0))[0];
    if (!rev) return null;

    // sets triés par id : le premier est le set d'origine (stable d'un run à l'autre → dossier d'image stable)
    const sets = [...(rev.cardSets || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(s => ({
        name: SET_NAMES[s.id] || clean(s.value) || clean(s.description) || String(s.id),
        code: clean(s.code) || SET_CODES[s.id] || '',
    }));
    const imageUrls = (rev.cardImages || [])
        .filter(i => i && clean(i.imageUrl))
        .sort((a, b) => rank(a.cardImageTypeId) - rank(b.cardImageTypeId))
        .map(i => clean(i.imageUrl).replace(/^\/+/, '').replace(/^CardImages\//i, ''));
    function rank(t) { const i = IMAGE_SIZE_ORDER.indexOf(t); return i < 0 ? 99 : i; }

    const entry = {
        id: raw.id,
        name: clean(rev.name),
        type: clean(rev.cardType?.value) || CARD_TYPES[rev.typeId] || null,
        landscape: clean(rev.landscape?.value) || (rev.landscapeId != null ? LANDSCAPES[rev.landscapeId] : null) || null,
        cost: rev.cost ?? null,
        attack: rev.attack ?? null,
        defense: rev.defense ?? null,
        ability: clean(rev.ability),
        rulings: clean(rev.rulings),
        set: sets[0]?.name ?? null,
        sets: sets.map(s => s.name),
        setCodes: sets.map(s => s.code),
        isCustomCard: !!raw.isCustomCard,
        revision: rev.revisionNumber ?? null,
        image: null,
        imageFrom: null,
        imageSha: null,
        url: CONFIG.cardPageBase + raw.id,
    };
    return { entry, imageUrls: [...new Set(imageUrls)] };
}

// ─────────────────────────────── Images ───────────────────────────────

/** Liste des fichiers du dépôt GitHub d'images (1 appel) → index par nom exact / minuscule / normalisé */
async function loadImagesRepo() {
    const url = `${CONFIG.githubApi}/repos/${CONFIG.imagesRepo}/git/trees/${CONFIG.imagesBranch}?recursive=1`;
    const r = await httpGet(url);
    if (!r.ok) {
        report('warning', 'Dépôt d\'images GitHub', '-', `liste des fichiers inaccessible (${r.error || 'HTTP ' + r.status}) : recherche directe par nom de fichier`);
        return null;
    }
    const body = JSON.parse(r.text);
    if (body.truncated) report('warning', 'Dépôt d\'images GitHub', '-', 'liste des fichiers tronquée par GitHub');
    const files = (body.tree || [])
        .filter(t => t.type === 'blob' && /\.(png|jpe?g|webp)$/i.test(t.path))
        // fichiers à la racine d'abord, dossiers "old" en dernier
        .sort((a, b) => (/(^|\/)old\//i.test(a.path) - /(^|\/)old\//i.test(b.path)) || (a.path.split('/').length - b.path.split('/').length));
    const idx = { count: files.length, empty: 0, exact: new Map(), lower: new Map(), norm: new Map() };
    for (const f of files) {
        if (!f.size) { idx.empty++; continue; } // fichier vide dans le dépôt
        const base = f.path.split('/').pop();
        if (!idx.exact.has(base)) idx.exact.set(base, f);
        if (!idx.lower.has(base.toLowerCase())) idx.lower.set(base.toLowerCase(), f);
        const n = norm(stripExt(base));
        idx.norm.set(n, [...(idx.norm.get(n) || []), f]);
    }
    return idx;
}

const rawUrl = p => `${CONFIG.githubRaw}/${CONFIG.imagesRepo}/${CONFIG.imagesBranch}/${encodePath(p)}`;

/** Sources possibles pour l'image d'une carte, dans l'ordre d'essai */
function imageCandidates(entry, imageUrls, repo) {
    const list = [];
    const add = c => { if (c && !list.some(x => x.url === c.url)) list.push(c); };
    const fromRepo = (f, guessed) => f && { kind: 'github', from: `github:${f.path}`, url: rawUrl(f.path), sha: f.sha || null, guessed };

    // 1. même nom de fichier que l'image utilisée par carddweeb (ex. "generated/medium/Finn.png" → "Finn.png")
    for (const u of imageUrls) {
        const base = decodeSafe(u.split('/').pop());
        if (!repo) { add({ kind: 'github', from: `github:${base}`, url: rawUrl(base), sha: null }); continue; }
        const hits = repo.norm.get(norm(stripExt(base)));
        add(fromRepo(repo.exact.get(base) || repo.lower.get(base.toLowerCase()) || (hits?.length === 1 ? hits[0] : null)));
    }
    // 2. image du site (URL donnée par l'API), seulement si le dépôt ne l'a pas
    if (CONFIG.useSiteImages && imageUrls[0]) add({ kind: 'site', from: `site:${imageUrls[0]}`, url: `${CONFIG.siteImagesBase}/${encodePath(imageUrls[0])}`, sha: null });
    // 3. dernier recours : fichier du dépôt portant le nom de la carte
    if (repo) {
        const hits = repo.norm.get(norm(entry.name));
        if (hits?.length === 1) add(fromRepo(hits[0], true));
    } else if (entry.name) {
        const guess = `${entry.name.replace(/\s+/g, '_')}.png`;
        add({ kind: 'github', from: `github:${guess}`, url: rawUrl(guess), sha: null, guessed: true });
    }
    return list;
}

const stats = { github: 0, site: 0, kept: 0, moved: 0, guessed: 0, rotated: 0, bytes: 0 };

/** Télécharge + convertit en WebP dans dest ; renvoie la source utilisée ou les erreurs */
async function fetchImage(dest, candidates) {
    const errors = [];
    for (const c of candidates) {
        const r = c.kind === 'site' ? await siteGet(c.url) : await httpGet(c.url);
        if (r.notFound) { errors.push(`${c.from} introuvable`); continue; }
        if (!r.ok) { errors.push(`${c.from} : ${r.error}`); continue; }
        if (/text\/html/i.test(r.contentType)) { errors.push(`${c.from} : page HTML au lieu d'une image`); continue; }
        try {
            let buffer = r.buffer;
            const meta = await sharp(buffer).metadata();
            const horizontal = meta.width > meta.height;
            if (horizontal) buffer = await sharp(buffer).rotate(-90).png().toBuffer(); // comme pour les autres jeux : tout en portrait
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await sharp(buffer)
                .resize({ width: CONFIG.maxWidth, height: CONFIG.maxHeight, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: CONFIG.webpQuality })
                .toFile(dest + '.tmp');
            await fsp.rename(dest + '.tmp', dest);
            stats[c.kind]++;
            if (c.guessed) stats.guessed++;
            if (horizontal) stats.rotated++;
            return { candidate: c, horizontal, errors };
        } catch (e) {
            errors.push(`${c.from} : image illisible (${e.message})`);
            try { await fsp.rm(dest + '.tmp', { force: true }); } catch { }
        }
    }
    return { errors };
}

/** "- Images/cp1/ : 54 images (Finn Vs Jake)" pour le rapport */
function folderLines(cards) {
    const folders = new Map();
    for (const c of cards) {
        if (!c.image) continue;
        const d = path.posix.dirname(c.image);
        const f = folders.get(d) || { n: 0, sets: new Set() };
        f.n++;
        if (c.set) f.sets.add(c.set);
        folders.set(d, f);
    }
    return [...folders].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        .map(([d, f]) => `- ${d}/ : ${f.n} image(s)${f.sets.size ? ` (${[...f.sets].join(', ')})` : ''}`);
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const t0 = Date.now();
    const bddPath = root(CONFIG.bddFile);
    let previous = [];
    try { previous = JSON.parse(await fsp.readFile(bddPath, 'utf8')); } catch { }
    if (!Array.isArray(previous)) previous = Object.values(previous || {});
    const prevById = new Map(previous.filter(c => c && c.id != null).map(c => [c.id, c]));

    // ── 1. Cartes (API) ──
    console.log(`📥 API carddweeb : ${CONFIG.apiBase}/cards`);
    let rawCards;
    try {
        rawCards = await fetchAllCards();
    } catch (e) {
        console.error(`\n💥 API inaccessible : ${e.message}\n   bdd.json n'est pas modifié.`);
        process.exitCode = 1;
        return;
    }
    if (!rawCards.length) {
        console.error('💥 L\'API n\'a renvoyé aucune carte : bdd.json n\'est pas modifié.');
        process.exitCode = 1;
        return;
    }
    if (prevById.size && rawCards.length < prevById.size * CONFIG.minRatioVsPrevious && !FORCE) {
        console.error(`💥 L'API ne renvoie que ${rawCards.length} cartes alors que bdd.json en contient ${prevById.size}. ` +
            `Rien n'est écrit (relancer avec FORCE=1 si c'est normal).`);
        process.exitCode = 1;
        return;
    }

    const cards = [];
    for (const raw of rawCards) {
        const n = normalizeCard(raw);
        if (!n) { report('error', 'Carte sans révision dans l\'API (ignorée)', raw.id, JSON.stringify(raw).slice(0, 120)); continue; }
        if (!n.entry.name) report('warning', 'Carte sans nom', raw.id, '');
        if (!n.entry.type) report('warning', 'Carte sans type', raw.id, n.entry.name);
        cards.push(n);
    }
    cards.sort((a, b) => a.entry.id - b.entry.id);
    console.log(`   ${cards.length} cartes (${cards.filter(c => c.entry.isCustomCard).length} communautaires)\n`);

    // ── 2. Images ──
    console.log(`🖼️  Images : github.com/${CONFIG.imagesRepo}`);
    const repo = await loadImagesRepo();
    if (repo) console.log(`   ${repo.count} fichiers dans le dépôt${repo.empty ? ` (${repo.empty} vides, ignorés)` : ''}`);

    let done = 0;
    await runPool(cards, CONFIG.githubConcurrency, async ({ entry, imageUrls }) => {
        const prev = prevById.get(entry.id);
        const rel = imagePathFor(entry);
        const dest = root(rel);
        const candidates = imageCandidates(entry, imageUrls, repo);
        const best = candidates[0];

        // image déjà téléchargée mais rangée ailleurs (ancien emplacement, ou set de la carte changé) → déplacée
        if (prev?.image && prev.image !== rel && fs.existsSync(root(prev.image))) {
            if (fs.existsSync(dest)) {
                await fsp.rm(root(prev.image), { force: true });
            } else {
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await fsp.rename(root(prev.image), dest);
                stats.moved++;
            }
        }

        const hasPrevImage = prev?.image && fs.existsSync(dest) && !REFRESH_IMAGES;
        const keepPrevious = () => {
            Object.assign(entry, { image: rel, imageFrom: prev.imageFrom, imageSha: prev.imageSha ?? null });
            if (prev.rotated) entry.rotated = true;
            stats.kept++;
        };
        const useResult = res => {
            entry.image = rel;
            entry.imageFrom = res.candidate.from;
            entry.imageSha = res.candidate.sha;
            if (res.horizontal) entry.rotated = true;
            if (res.candidate.kind === 'site') report('warning', 'Images absentes du dépôt GitHub (prises sur carddweeb.com)', entry.id, `${entry.name} — ${res.candidate.from.slice(5)}`);
            if (res.candidate.guessed) report('warning', 'Images trouvées seulement par le nom de la carte (à vérifier)', entry.id, `${entry.name} → ${res.candidate.from.slice(7)}`);
        };

        if (hasPrevImage && best && prev.imageFrom === best.from && (!best.sha || !prev.imageSha || prev.imageSha === best.sha)) {
            keepPrevious(); // image déjà présente et toujours à jour
        } else if (hasPrevImage && String(prev.imageFrom).startsWith('site:')) {
            // image prise sur carddweeb.com lors d'un run précédent : on ne retourne pas sur le site,
            // on regarde seulement si le dépôt GitHub l'a maintenant
            const fromRepo = candidates.filter(c => c.kind === 'github' && !c.guessed);
            const res = fromRepo.length ? await fetchImage(dest, fromRepo) : {};
            if (res.candidate) useResult(res); else keepPrevious();
        } else if (!candidates.length) {
            report('error', 'Aucune image connue pour la carte', entry.id, entry.name);
        } else {
            const res = await fetchImage(dest, candidates);
            if (res.candidate) {
                useResult(res);
            } else if (prev?.image && fs.existsSync(dest)) {
                // échec du téléchargement : on garde l'ancienne image
                keepPrevious();
                report('warning', 'Image non mise à jour (ancienne gardée)', entry.id, `${entry.name} — ${res.errors.join(' ; ')}`);
            } else {
                report('error', 'Image non téléchargée', entry.id, `${entry.name} — ${res.errors.join(' ; ')}`);
            }
        }
        if (entry.image) { try { stats.bytes += fs.statSync(root(entry.image)).size; } catch { } }
        if (++done % 50 === 0 || done === cards.length) process.stdout.write(`\r   ${done}/${cards.length} cartes traitées`);
    });
    process.stdout.write('\n');

    // ── 3. bdd.json ──
    const out = cards.map(c => c.entry);
    const known = new Set(out.map(c => c.id));
    for (const [id, prev] of prevById) {
        if (known.has(id)) continue;
        out.push(prev); // carte retirée de l'API : gardée
        report('warning', 'Cartes plus présentes dans l\'API (gardées dans bdd.json)', id, prev.name);
    }
    out.sort((a, b) => a.id - b.id);
    await writeFileAtomic(bddPath, JSON.stringify(out, null, 2) + '\n');

    // ── 4. Rapport ──
    const withImage = out.filter(c => c.image).length;
    const countBy = f => Object.entries(out.reduce((m, c) => { for (const k of [].concat(f(c) ?? '—')) m[k] = (m[k] || 0) + 1; return m; }, {}))
        .sort((a, b) => b[1] - a[1]);
    const newCards = prevById.size ? out.filter(c => !prevById.has(c.id)) : [];
    const lines = [
        `# Card Wars — import du ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
        `- Sources : API carddweeb (${rawCards.length} cartes) · images github.com/${CONFIG.imagesRepo}${repo ? ` (${repo.count} fichiers)` : ''}`,
        `- Cartes dans bdd.json : **${out.length}** (officielles : ${out.filter(c => !c.isCustomCard).length}, communautaires : ${out.filter(c => c.isCustomCard).length})`,
        `- Avec image : ${withImage} · sans image : ${out.length - withImage}`,
        `- Images ce run : ${stats.github} depuis GitHub, ${stats.site} depuis carddweeb.com, ${stats.kept} déjà à jour` +
        `${stats.moved ? ` (dont ${stats.moved} déplacées dans leur dossier de set)` : ''}${stats.rotated ? `, ${stats.rotated} tournées` : ''}`,
        `- Poids du dossier ${CONFIG.imagesDir}/ : ${(stats.bytes / 1048576).toFixed(1)} Mo (${withImage ? Math.round(stats.bytes / withImage / 1024) : 0} Ko/carte en moyenne)`,
        `- Durée : ${Math.round((Date.now() - t0) / 1000)} s`, '',
        '## Types', '', ...countBy(c => c.type).map(([k, n]) => `- ${k} : ${n}`), '',
        '## Sets', '', ...countBy(c => c.sets?.length ? c.sets : null).map(([k, n]) => `- ${k} : ${n}`), '',
        '## Landscapes', '', ...countBy(c => c.landscape).map(([k, n]) => `- ${k} : ${n}`), '',
        '## Dossiers d\'images', '', ...folderLines(out), '',
    ];
    const byCat = new Map();
    for (const i of issues) {
        const key = `${i.level === 'error' ? '❌' : '⚠️'} ${i.category}`;
        byCat.set(key, [...(byCat.get(key) || []), i]);
    }
    for (const [cat, items] of byCat) lines.push(`## ${cat} (${items.length})`, '', ...items.map(i => `- \`${i.id}\`${i.message ? ' ' + i.message : ''}`), '');
    if (newCards.length) lines.push(`## 🆕 Nouvelles cartes (${newCards.length})`, '', ...newCards.map(c => `- \`${c.id}\` ${c.name} (${c.set || 'sans set'})`), '');
    await writeFileAtomic(CONFIG.reportPath, lines.join('\n'));

    console.log(`\n💾 ${CONFIG.bddFile} : ${out.length} cartes, ${withImage} avec image` +
        ` (${stats.github} téléchargées depuis GitHub, ${stats.site} depuis carddweeb.com, ${stats.kept} déjà à jour` +
        `${stats.moved ? `, ${stats.moved} déplacées dans leur dossier de set` : ''})`);
    console.log(`   ${CONFIG.imagesDir}/ : ${(stats.bytes / 1048576).toFixed(1)} Mo`);
    for (const [cat, items] of byCat) {
        console.log(`\n${cat} (${items.length})`);
        items.slice(0, 15).forEach(i => console.log(`   - ${i.id} : ${i.message}`));
        if (items.length > 15) console.log(`   … voir ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    }
    if (newCards.length) console.log(`\n🆕 ${newCards.length} nouvelle(s) carte(s)`);
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
}

main().catch(e => { console.error('💥', e); process.exitCode = 1; });
