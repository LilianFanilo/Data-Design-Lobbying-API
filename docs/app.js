import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

// Clé publique : elle ne permet que la lecture (Row Level Security côté Supabase).
const supabase = createClient(
  "https://hmahqciqmldynzltzgtd.supabase.co",
  "sb_publishable_zxYnoslTFqCAj7MpY0VM1g_v3TV7sWm"
);

// Filtres possibles sur les activités (colonnes de la table explo_activites)
const DIMS = {
  domaines:         { label: "Domaine",            tableau: true },
  ministeres:       { label: "Ministère visé",     tableau: true },
  responsables:     { label: "Responsable public", tableau: true },
  types_action:     { label: "Type d'action",      tableau: true },
  decisions:        { label: "Décision visée",     tableau: true },
  secteurs:         { label: "Secteur",            tableau: true },
  niveaux:          { label: "Niveau",             tableau: true },
  categorie:        { label: "Catégorie" },
  depense:          { label: "Dépense lobbying" },
  chiffre_affaires: { label: "Chiffre d'affaires" },
};
const PAGE = 50;
const valeurs = {}; // valeurs[dim] = [{ valeur, n, ordre }]

// ---------------------------------------------------------------- utilitaires
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n == null ? "—" : new Intl.NumberFormat("fr-FR").format(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// {"valeur, avec virgule"} : format tableau PostgreSQL
const pgArray = (v) => '{"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"}';
// "%texte%" : motif ILIKE pour les filtres or=(...)
const motif = (q) => '"%' + q.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '%"';

function trier(dim) {
  const l = valeurs[dim] || [];
  return l.some((v) => v.ordre != null) ? [...l].sort((a, b) => (a.ordre ?? 1e15) - (b.ordre ?? 1e15)) : l;
}

function tags(dim, liste, cliquable = true) {
  if (!liste?.length) return "—";
  return liste.map((v) => cliquable
    ? `<button class="tag" data-dim="${dim}" data-val="${esc(v)}">${esc(v)}</button>`
    : `<span class="tag fixe">${esc(v)}</span>`).join("");
}

function pagination(el, page, total, aller) {
  const nb = Math.ceil(total / PAGE);
  el.innerHTML = nb <= 1 ? "" : `
    <button data-p="${page - 1}" ${page === 0 ? "disabled" : ""}>←</button>
    <span>Page ${page + 1} / ${fmt(nb)}</span>
    <button data-p="${page + 1}" ${page >= nb - 1 ? "disabled" : ""}>→</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("button[data-p]");
    if (b && !b.disabled) { aller(Number(b.dataset.p)); scrollTo(0, 0); }
  };
}

// ---------------------------------------------------------------- onglets
const charge = new Set();
function afficherVue(vue) {
  if (!["organisations", "activites"].includes(vue)) vue = "organisations";
  for (const v of ["organisations", "activites"]) $(`#vue-${v}`).hidden = v !== vue;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("actif", b.dataset.vue === vue));
  if (location.hash !== "#" + vue) history.replaceState(null, "", "#" + vue);
  if (!charge.has(vue)) { charge.add(vue); vue === "organisations" ? chargerOrganisations() : chargerActivites(); }
}
$("nav").onclick = (e) => { const b = e.target.closest("button[data-vue]"); if (b) afficherVue(b.dataset.vue); };
addEventListener("hashchange", () => afficherVue(location.hash.slice(1)));

// ---------------------------------------------------------------- organisations
const COLS = [
  { label: "Organisation",       tri: "denomination", asc: true },
  { label: "Catégorie",          tri: "categorie",    asc: true },
  { label: "Ville",              tri: "ville",        asc: true },
  { label: "Activités",          tri: "nb_activites" },
  { label: "Période",            tri: "derniere_annee" },
  { label: "Dépense lobbying",   tri: "depense_recente_ordre" },
  { label: "Chiffre d'affaires", tri: "ca_recent_ordre" },
  { label: "Clients",            tri: "nb_clients" },
];
const org = { q: "", categorie: "", secteur: "", actives: true, tri: "nb_activites", asc: false, page: 0 };
let jetonOrg = 0;

function initOrganisations() {
  const options = (dim) => trier(dim).map((v) => `<option>${esc(v.valeur)}</option>`).join("");
  $("#org-categorie").insertAdjacentHTML("beforeend", options("categorie"));
  $("#org-secteur").insertAdjacentHTML("beforeend", options("secteurs"));
  const relancer = () => { org.page = 0; chargerOrganisations(); };
  $("#org-q").oninput = debounce(() => { org.q = $("#org-q").value.trim(); relancer(); });
  $("#org-categorie").onchange = (e) => { org.categorie = e.target.value; relancer(); };
  $("#org-secteur").onchange = (e) => { org.secteur = e.target.value; relancer(); };
  $("#org-actives").onchange = (e) => { org.actives = e.target.checked; relancer(); };
  $("#org-table").onclick = (e) => {
    const th = e.target.closest("button[data-tri]");
    if (th) {
      const c = COLS.find((c) => c.tri === th.dataset.tri);
      org.asc = org.tri === c.tri ? !org.asc : !!c.asc;
      org.tri = c.tri;
      return relancer();
    }
    const tr = e.target.closest("tr[data-id]");
    if (tr) ouvrirFiche(Number(tr.dataset.id));
  };
}

async function chargerOrganisations() {
  const jeton = ++jetonOrg;
  let req = supabase.from("explo_organisations").select(
    "representants_id, denomination, sigle, categorie, ville, nb_activites, premiere_annee, derniere_annee, depense_recente, ca_recent, nb_clients",
    { count: "exact" });
  if (org.q) req = req.or(`denomination.ilike.${motif(org.q)},sigle.ilike.${motif(org.q)}`);
  if (org.categorie) req = req.eq("categorie", org.categorie);
  if (org.secteur) req = req.filter("secteurs", "cs", pgArray(org.secteur));
  if (org.actives) req = req.gt("nb_activites", 0);
  const { data, count, error } = await req
    .order(org.tri, { ascending: org.asc, nullsFirst: false }).order("representants_id")
    .range(org.page * PAGE, org.page * PAGE + PAGE - 1);
  if (jeton !== jetonOrg) return;
  if (error) { $("#org-resume").innerHTML = `<span class="erreur">${esc(error.message)}</span>`; return; }

  $("#org-resume").textContent = `${fmt(count)} organisations`;
  const tete = COLS.map((c) => `<th>
    <button data-tri="${c.tri}">${c.label}${org.tri === c.tri ? (org.asc ? " ↑" : " ↓") : ""}</button></th>`).join("");
  const lignes = data.map((o) => `<tr data-id="${o.representants_id}">
    <td><b>${esc(o.denomination)}</b>${o.sigle ? `<br><small>${esc(o.sigle)}</small>` : ""}</td>
    <td>${esc(o.categorie || "—")}</td>
    <td>${esc(o.ville || "—")}</td>
    <td class="num">${fmt(o.nb_activites)}</td>
    <td class="num">${o.premiere_annee ? `${o.premiere_annee}–${o.derniere_annee}` : "—"}</td>
    <td class="num">${esc(o.depense_recente || "—")}</td>
    <td class="num">${esc(o.ca_recent || "—")}</td>
    <td class="num">${fmt(o.nb_clients)}</td></tr>`).join("");
  $("#org-table").innerHTML = `<thead><tr>${tete}</tr></thead><tbody>${lignes}</tbody>`;
  pagination($("#org-pagination"), org.page, count, (p) => { org.page = p; chargerOrganisations(); });
}

// ---------------------------------------------------------------- fiche organisation
async function ouvrirFiche(id) {
  $("#fiche").hidden = false;
  $("#fiche-contenu").innerHTML = "Chargement…";
  const par = (table, cols) => supabase.from(table).select(cols).eq("representants_id", id);
  const [o, ex, dir, cli, aff] = await Promise.all([
    supabase.from("explo_organisations").select("*").eq("representants_id", id).maybeSingle(),
    par("exercices", "annee_debut, montant_depense, chiffre_affaires, nombre_activites"),
    par("dirigeants", "prenom_dirigeant, nom_dirigeant, fonction_dirigeant"),
    par("clients", "denomination_client").limit(500),
    par("affiliations", "denomination_affiliation"),
  ]);
  const d = o.data;
  if (!d) { $("#fiche-contenu").textContent = "Organisation introuvable."; return; }
  const exercices = (ex.data || []).sort((a, b) => String(b.annee_debut).localeCompare(String(a.annee_debut)));
  const liste = (titre, l, f) => `<details><summary>${titre} (${l?.length || 0})</summary><ul>${(l || []).map((x) => `<li>${esc(f(x))}</li>`).join("")}</ul></details>`;

  $("#fiche-contenu").innerHTML = `
    <h2>${esc(d.denomination)}</h2>
    <small>${esc([d.sigle, d.categorie, d.ville].filter(Boolean).join(" · "))}</small>
    ${d.site_web ? `<br><a href="${esc(/^https?:/i.test(d.site_web) ? d.site_web : "https://" + d.site_web)}" target="_blank" rel="noopener">${esc(d.site_web)}</a>` : ""}
    <p>${fmt(d.nb_activites)} activités · dépense récente : ${esc(d.depense_recente || "—")} · CA : ${esc(d.ca_recent || "—")}</p>
    ${d.nb_activites ? `<button class="lien" data-voir>Voir ses activités →</button>` : ""}
    <h3>Domaines principaux</h3>${tags("domaines", d.top_domaines)}
    <h3>Ministères les plus visés</h3>${tags("ministeres", d.top_ministeres)}
    <h3>Secteurs</h3>${tags("secteurs", d.secteurs, false)}
    <h3>Exercices</h3>
    <table><tr><th>Année</th><th>Dépense</th><th>CA</th><th class="num">Activités</th></tr>
      ${exercices.map((e) => `<tr><td>${esc(e.annee_debut)}</td><td>${esc(e.montant_depense || "—")}</td><td>${esc(e.chiffre_affaires || "—")}</td><td class="num">${fmt(e.nombre_activites)}</td></tr>`).join("")}
    </table>
    ${liste("Dirigeants", dir.data, (x) => `${x.prenom_dirigeant || ""} ${x.nom_dirigeant || ""}${x.fonction_dirigeant ? " — " + x.fonction_dirigeant : ""}`)}
    ${liste("Clients", cli.data, (x) => x.denomination_client)}
    ${liste("Affiliations", aff.data, (x) => x.denomination_affiliation)}`;

  const cible = { id: d.representants_id, nom: d.denomination };
  $("#fiche-contenu").onclick = (e) => {
    if (e.target.closest("[data-voir]")) return voirActivites(cible);
    const t = e.target.closest(".tag[data-dim]");
    if (t) voirActivites(cible, [{ dim: t.dataset.dim, val: t.dataset.val }]);
  };
}
const fermerFiche = () => { $("#fiche").hidden = true; };
$("#fiche-fermer").onclick = fermerFiche;
addEventListener("keydown", (e) => { if (e.key === "Escape") fermerFiche(); });

// ---------------------------------------------------------------- activités
const act = { q: "", filtres: [], org: null, tri: "date_desc", page: 0 };
let jetonAct = 0;

function ajouterFiltre(dim, val) {
  // dimensions à valeurs multiples : on cumule ; sinon la nouvelle valeur remplace l'ancienne
  if (!DIMS[dim].tableau) act.filtres = act.filtres.filter((f) => f.dim !== dim);
  if (!act.filtres.some((f) => f.dim === dim && f.val === val)) act.filtres.push({ dim, val });
}

function dessinerFiltres() {
  const actifs = [
    ...(act.org ? [`<button class="tag actif" data-org>${esc(act.org.nom)} ×</button>`] : []),
    ...act.filtres.map((f, i) => `<button class="tag actif" data-i="${i}">${esc(DIMS[f.dim].label)} : ${esc(f.val)} ×</button>`),
  ].join("");
  $("#act-filtres").innerHTML = `
    <div class="barre">
      <input type="search" id="act-q" placeholder="Rechercher dans l'objet ou l'organisation…" value="${esc(act.q)}">
      <select id="act-dim"><option value="">Filtrer par…</option>
        ${Object.entries(DIMS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join("")}</select>
      <select id="act-val" hidden></select>
    </div>
    <div>${actifs}</div>`;
  $("#act-q").oninput = debounce(() => { act.q = $("#act-q").value.trim(); relancerActivites(false); });
  $("#act-dim").onchange = (e) => {
    const dim = e.target.value, sel = $("#act-val");
    sel.hidden = !dim;
    sel.innerHTML = `<option value="">— valeur —</option>` +
      trier(dim).map((v) => `<option value="${esc(v.valeur)}">${esc(v.valeur)} (${fmt(v.n)})</option>`).join("");
    sel.onchange = () => { if (sel.value) { ajouterFiltre(dim, sel.value); relancerActivites(); } };
  };
  $("#act-filtres").onclick = (e) => {
    const t = e.target.closest(".tag.actif");
    if (!t) return;
    if (t.dataset.org !== undefined) act.org = null; else act.filtres.splice(Number(t.dataset.i), 1);
    relancerActivites();
  };
}

function relancerActivites(redessiner = true) {
  act.page = 0;
  if (redessiner) dessinerFiltres();
  chargerActivites();
}

function voirActivites(organisation = null, filtres = []) {
  fermerFiche();
  Object.assign(act, { q: "", filtres: [], org: organisation });
  filtres.forEach((f) => ajouterFiltre(f.dim, f.val));
  dessinerFiltres();
  charge.add("activites");
  afficherVue("activites");
  relancerActivites(false);
}

async function chargerActivites() {
  const jeton = ++jetonAct;
  let req = supabase.from("explo_activites").select(
    "representants_id, denomination, date_publication, objet, domaines, ministeres, types_action", { count: "exact" });
  for (const { dim, val } of act.filtres) req = DIMS[dim].tableau ? req.filter(dim, "cs", pgArray(val)) : req.eq(dim, val);
  if (act.q) req = req.or(`objet.ilike.${motif(act.q)},denomination.ilike.${motif(act.q)}`);
  if (act.org) req = req.eq("representants_id", act.org.id);
  req = act.tri === "org"
    ? req.order("denomination").order("date_publication", { ascending: false, nullsFirst: false })
    : req.order("date_publication", { ascending: act.tri === "date_asc", nullsFirst: false });
  const { data, count, error } = await req.order("activite_id").range(act.page * PAGE, act.page * PAGE + PAGE - 1);
  if (jeton !== jetonAct) return;
  if (error) { $("#act-resume").innerHTML = `<span class="erreur">${esc(error.message)}</span>`; return; }

  $("#act-resume").textContent = `${fmt(count)} activités · clic sur une étiquette pour filtrer`;
  $("#act-liste").innerHTML = data.map((a) => `<li>
    <div class="meta"><button class="lien" data-org="${a.representants_id}">${esc(a.denomination || "?")}</button>
      · ${a.date_publication ? new Date(a.date_publication).toLocaleDateString("fr-FR") : "date inconnue"}</div>
    <p>${esc(a.objet)}</p>
    ${tags("domaines", a.domaines)}${tags("ministeres", a.ministeres)}
  </li>`).join("") || "<li>Aucun résultat.</li>";
  pagination($("#act-pagination"), act.page, count, (p) => { act.page = p; chargerActivites(); });
}

$("#act-liste").onclick = (e) => {
  const t = e.target.closest(".tag[data-dim]");
  if (t) { ajouterFiltre(t.dataset.dim, t.dataset.val); return relancerActivites(); }
  const o = e.target.closest("[data-org]");
  if (o) ouvrirFiche(Number(o.dataset.org));
};
$("#act-tri").onchange = (e) => { act.tri = e.target.value; act.page = 0; chargerActivites(); };

// ---------------------------------------------------------------- démarrage
const [dims, nbOrg, nbAct] = await Promise.all([
  supabase.from("explo_dimensions").select("dim, valeur, nb_activites, ordre").order("nb_activites", { ascending: false }).limit(2000),
  supabase.from("explo_organisations").select("*", { count: "exact", head: true }).gt("nb_activites", 0),
  supabase.from("explo_activites").select("*", { count: "exact", head: true }),
]);
if (dims.error) {
  $("#chiffres").innerHTML = `<span class="erreur">Base injoignable : ${esc(dims.error.message)}</span>`;
} else {
  for (const d of dims.data) (valeurs[d.dim] ||= []).push({ valeur: d.valeur, n: d.nb_activites, ordre: d.ordre });
  $("#chiffres").textContent = `${fmt(nbOrg.count)} organisations · ${fmt(nbAct.count)} activités · source : HATVP`;
  initOrganisations();
  dessinerFiltres();
  afficherVue(location.hash.slice(1));
}
