#!/usr/bin/env node
/**
 * Génère CardWarsCards.json (liste de cartes TCG Arena) à partir de bdd.json (créé par Download_CardWars.js).
 *
 *  - Format TCG Arena, comme les autres jeux : id, face.front, name, type, cost, landscape, attack, defense, set
 *    - id    = "CW-" + id carddweeb ("CW-107")
 *    - name  = nom de la carte : les cartes de même nom (réimpressions, versions Kickstarter…) sont regroupées
 *              comme skins par TCG Arena ("Cornfield 1" … "Cornfield 4" restent des cartes distinctes)
 *    - image = Images/<set>/<id>.webp sur GitHub Pages
 *  - Les cartes communautaires de carddweeb sont incluses (set "Custom Community Cards")
 *  - Les cartes sans image ne sont pas incluses
 *  - Une carte qui disparaît de bdd.json est conservée telle quelle (aucune carte perdue pour les decks existants)
 *  - Rapport dans Scripts/cardlist-report.md
 *
 * Emplacement : Scripts/Generate_CardList.js (les chemins partent de la racine du repo)
 * Usage       : node Scripts/Generate_CardList.js      (FORCE=1 pour écrire même si beaucoup de cartes manquent)
 * Dépendances : aucune (Node 18+)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),
    bddFile: 'bdd.json',                     // créé par Download_CardWars.js
    cardsFile: 'CardWarsCards.json',         // fichier du jeu, à la racine du repo
    reportPath: path.join(__dirname, 'cardlist-report.md'),

    // adresse GitHub Pages du repo qui contient le dossier Images/
    pagesBaseUrl: trimSlash(process.env.PAGES_BASE_URL || 'https://valcur.github.io/TCG-Arena-CardWars'),

    noSetName: 'No Set',                     // valeur de "set" pour les cartes sans set (les landscapes sur carddweeb)
    minRatioVsPrevious: 0.8,                 // refuse d'écrire si on perd >20% des cartes (FORCE=1 pour forcer)
};

// ordre des sets dans le fichier (ordre de carddweeb ≈ ordre de sortie), puis ordre des types
const SET_ORDER = ['Finn Vs Jake', 'BMO Vs Lady Rainicorn', 'Princess Bubblegum Vs Lumpy Space Princess', 'Ice King Vs Marceline',
    'Lemon Grab Vs Gunter', 'Fionna Vs Cake', 'Doubles Tournament', 'Hero Pack', 'For The Glory', 'Promo', 'Kickstarter #1',
    'Flame Princess Vs Fern', 'Prismo Vs The Lich', 'Peppermint Butler Vs Magic Man', 'Kickstarter #2', 'DarkLands Expansion',
    'Custom Community Cards', 'Land of Legends', 'Kickstarter #3'];
const TYPE_ORDER = ['Hero', 'Landscape', 'Creature', 'Building', 'Spell', 'Teamwork'];

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = [];
function report(level, category, id, message) { issues.push({ level, category, id: String(id), message: message || '' }); }

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.relative(CONFIG.repoRoot, file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', content);
    await fsp.rename(file + '.tmp', file);
}

function imageUrl(relPath) {
    return `${CONFIG.pagesBaseUrl}/${String(relPath).split('/').map(encodeURIComponent).join('/')}`;
}

// ─────────────────────────────── Format CardWarsCards.json ───────────────────────────────

/** "CW-107" : préfixe pour que l'ordre du fichier soit respecté (un objet JSON trie les clés purement numériques) */
function cardId(c) { return `CW-${c.id}`; }

function buildCardEntry(c) {
    const id = cardId(c);
    const name = clean(c.name);
    const type = clean(c.type) || 'Unknown';
    const cost = toInt(c.cost);
    const entry = {
        id,
        face: {
            front: { name, type, cost, image: imageUrl(c.image), isHorizontal: c.rotated === true },
        },
        name,
        type,
        cost,
        landscape: clean(c.landscape) || undefined, // absent pour les cartes sans landscape (Heroes…)
        attack: toInt(c.attack),
        defense: toInt(c.defense),
        set: clean(c.set) || CONFIG.noSetName,
    };
    return JSON.parse(JSON.stringify(entry)); // retire les champs undefined
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const lines = [];
    lines.push(`# Liste des cartes Card Wars — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    lines.push(`| Cartes dans ${CONFIG.bddFile} | ${summary.bddCount} |`);
    lines.push(`| Cartes dans ${CONFIG.cardsFile} | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Noms différents (cartes jouables) | ${summary.nameCount} |`);
    lines.push(`| Cartes regroupées en skins | ${summary.skinGroups.length} noms, ${summary.skinGroups.reduce((n, [, l]) => n + l.length, 0)} cartes |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Cartes disparues de ${CONFIG.bddFile} (conservées) | ${summary.kept.length} |`);
    lines.push(`| Dont cartes communautaires (non officielles) | ${summary.custom} |`);
    lines.push(`| Cartes ignorées faute d'image | ${summary.noImage} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    if (summary.bySet.length) {
        lines.push('## Sets', '', '| Set | Cartes |', '|---|---|');
        summary.bySet.forEach(([s, n]) => lines.push(`| ${s} | ${n} |`));
        lines.push('');
    }

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.slice(0, 300).forEach(i => lines.push(`- \`${i.id}\`${i.message ? ' — ' + i.message : ''}`));
            if (items.length > 300) lines.push(`- … et ${items.length - 300} autre(s)`);
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.skinGroups.length) {
        lines.push(`## 🎨 Cartes regroupées en skins (${summary.skinGroups.length})`, '');
        lines.push('Même nom → une seule carte dans TCG Arena, avec plusieurs illustrations.', '');
        summary.skinGroups.forEach(([name, l]) => lines.push(`- **${name}** — ${l.map(e => `\`${e.id}\` ${e.set}`).join(' · ')}`));
        lines.push('');
    }
    if (summary.added.length && summary.previousCount) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        summary.added.forEach(e => lines.push(`- \`${e.id}\` ${e.name} (${e.set})`));
        lines.push('');
    }
    return lines.join('\n');
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir Scripts/cardlist-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id}${i.message ? ' : ' + i.message : ''}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = { bddCount: 0, cardCount: 0, previousCount: 0, nameCount: 0, skinGroups: [], added: [], kept: [], custom: 0, noImage: 0, bySet: [], fatal: null };

    try {
        // ── 1. Lecture de bdd.json et de l'ancienne liste ──
        const bddPath = rel(CONFIG.bddFile);
        if (!fs.existsSync(bddPath)) throw new FatalError(`${CONFIG.bddFile} introuvable : lance d'abord Scripts/Download_CardWars.js`);
        let bdd;
        try { bdd = JSON.parse(await fsp.readFile(bddPath, 'utf8')); } catch (e) { throw new FatalError(`${CONFIG.bddFile} illisible : ${e.message}`); }
        const cards = (Array.isArray(bdd) ? bdd : Object.values(bdd || {})).filter(c => c && c.id != null);
        if (!cards.length) throw new FatalError(`${CONFIG.bddFile} ne contient aucune carte`);
        summary.bddCount = cards.length;

        const cardsPath = rel(CONFIG.cardsFile);
        const previousCards = await readJsonIfExists(cardsPath, {});
        summary.previousCount = Object.keys(previousCards).length;
        console.log(`📖 ${CONFIG.bddFile} : ${cards.length} cartes · ${CONFIG.cardsFile} actuel : ${summary.previousCount} cartes`);

        // ── 2. Construction des cartes ──
        const out = {};
        for (const c of cards) {
            if (!clean(c.name)) { report('error', 'Cartes sans nom (ignorées)', c.id); continue; }
            if (!c.image) {
                summary.noImage++;
                report('warning', 'Cartes sans image (ignorées)', c.id, clean(c.name));
                continue;
            }
            if (!fs.existsSync(rel(c.image))) {
                summary.noImage++;
                report('error', 'Image absente du dossier Images/ (carte ignorée, relancer Download_CardWars.js)', c.id, `${clean(c.name)} — ${c.image}`);
                continue;
            }
            if (!clean(c.type)) report('warning', 'Cartes sans type (mises en "Unknown")', c.id, clean(c.name));
            out[cardId(c)] = buildCardEntry(c);
            if (c.isCustomCard) summary.custom++;
        }

        const realIds = Object.keys(out);
        if (!realIds.length) throw new FatalError('Aucune carte utilisable dans bdd.json (toutes sans image ?)');
        if (summary.previousCount && realIds.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} cartes contre ${summary.previousCount} dans le ${CONFIG.cardsFile} actuel. ` +
                'Relancer avec FORCE=1 pour écraser quand même.');
        }

        // ── 3. Comparaison avec l'ancienne liste ──
        summary.added = realIds.filter(id => !(id in previousCards)).map(id => out[id]);
        const bddIds = new Set(cards.map(cardId));
        for (const [id, prev] of Object.entries(previousCards)) {
            // carte encore dans bdd.json mais exclue (sans image, communautaire) : pas conservée
            if (out[id] || bddIds.has(id)) continue;
            out[id] = prev; // aucune carte perdue pour les decks existants
            summary.kept.push(id);
            report('warning', `Cartes disparues de ${CONFIG.bddFile} (conservées telles quelles)`, id, prev?.name || '');
        }

        // ── 4. Skins : cartes de même nom ──
        const byName = new Map();
        for (const e of Object.values(out)) byName.set(e.name, [...(byName.get(e.name) || []), e]);
        summary.nameCount = byName.size;
        summary.skinGroups = [...byName].filter(([, l]) => l.length > 1).sort(([a], [b]) => a.localeCompare(b));
        const stats = e => [e.type, e.cost, e.landscape, e.attack, e.defense].join('|');
        for (const [name, l] of summary.skinGroups) {
            if (new Set(l.map(stats)).size > 1) {
                report('warning', 'Même nom mais stats différentes (regroupées en skins quand même)', name,
                    l.map(e => `${e.id} [${e.set}] ${e.type} coût ${e.cost}${e.type === 'Creature' ? ` ${e.attack}/${e.defense}` : ''}${e.landscape ? ' ' + e.landscape : ''}`).join(' ; '));
            }
        }

        // ── 5. Écriture (triée par set, type, nom) ──
        const setRank = s => { const i = SET_ORDER.indexOf(s); return i < 0 ? (s === CONFIG.noSetName ? 1000 : 500) : i; };
        const typeRank = t => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? 99 : i; };
        const sorted = Object.keys(out).sort((a, b) => {
            const ea = out[a], eb = out[b];
            return setRank(ea.set) - setRank(eb.set) || String(ea.set).localeCompare(String(eb.set)) ||
                typeRank(ea.type) - typeRank(eb.type) || String(ea.name).localeCompare(String(eb.name)) ||
                a.localeCompare(b, 'en', { numeric: true });
        });
        await writeFileAtomic(cardsPath, JSON.stringify(Object.fromEntries(sorted.map(k => [k, out[k]])), null, 2) + '\n');
        summary.cardCount = sorted.length;

        const bySet = new Map();
        for (const id of sorted) bySet.set(out[id].set, (bySet.get(out[id].set) || 0) + 1);
        summary.bySet = [...bySet];

        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes, ${summary.nameCount} noms différents ` +
            `(${summary.added.length} nouvelles, ${summary.kept.length} disparues de ${CONFIG.bddFile} conservées)`);
        console.log(`   dont ${summary.custom} carte(s) communautaire(s), ` +
            `${summary.noImage} ignorée(s) faute d'image, ${summary.skinGroups.length} nom(s) avec plusieurs skins`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    if (!summary.fatal || issues.length) printIssuesToConsole();
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
