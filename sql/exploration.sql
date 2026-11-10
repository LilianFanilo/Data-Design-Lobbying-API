-- ============================================================================
-- Tables d'exploration pour le front (recherche, tri, jointures, croisements)
-- Construites à partir des tables brutes importées par migrer_vers_supabase.py.
-- Ré-exécutable : tout est supprimé puis recréé.
-- ============================================================================

drop function if exists explo_croiser(text, text, text, jsonb, int, int, text, int);
drop function if exists explo_croiser_calcul(text, text, text, jsonb, int, int, text, int);
drop table if exists explo_cache;
drop table if exists explo_dimensions;
drop table if exists explo_organisations;
drop table if exists explo_activites;

-- ---------------------------------------------------------------------------
-- Nettoyage des libellés
-- ---------------------------------------------------------------------------

-- Libellés courts pour le type de responsable public
create or replace function explo_responsable(r text) returns text
language sql immutable as $$
  select case
    when r like 'Membre du Gouvernement%'                     then 'Gouvernement et cabinets ministériels'
    when r like 'Député%'                                     then 'Parlement (députés, sénateurs, collaborateurs)'
    when r like 'Élu ou membre de cabinet%'                   then 'Élus locaux et leurs cabinets'
    when r like 'Agent de l%État'                             then 'Agents de l’État'
    when r like 'Titulaire d%emploi%'                         then 'Emplois à la décision du Gouvernement'
    when r like 'Collaborateur du Président de la République%' then 'Présidence de la République'
    when r like 'Directeur ou secrétaire général%'            then 'Autorités administratives indépendantes'
    when r like 'Agent d%une collectivité%'                   then 'Agents des collectivités territoriales'
    when r like 'Agent d%un centre hospitalier%'              then 'Agents hospitaliers'
  end
$$;

-- Les noms de ministères ont été coupés sur les virgules à l'import
-- ("Environnement" + "énergie et mer") : on recolle et on jette les fragments.
create or replace function explo_ministere(d text) returns text
language sql immutable as $$
  select case
    when t is null or t = ''                       then null
    when t ~ '^[a-zàâäéèêëîïôöùûüç]'               then null  -- fragment après une virgule
    when t = 'Environnement'                       then 'Environnement, énergie et mer'
    when t = 'Agriculture'                         then 'Agriculture, agroalimentaire et forêt'
    when t = 'Travail'                             then 'Travail, emploi, formation professionnelle et dialogue social'
    when t = 'Aménagement du territoire'           then 'Aménagement du territoire, ruralité et collectivités territoriales'
    when t = 'Education nationale'                 then 'Éducation nationale, enseignement supérieur et recherche'
    when t = 'Ville'                               then 'Ville, jeunesse et sport'
    when t = 'Famille'                             then 'Famille, enfance et droits des femmes'
    when t = 'Autres : à préciser'                 then 'Autres'
    else t
  end
  from (select btrim(d) as t) s
$$;

-- Ordre numérique d'une tranche "≥ 10 000 € et < 25 000 €" (pour trier)
create or replace function explo_ordre_tranche(label text) returns numeric
language sql immutable as $$
  select case
    when label is null or btrim(label) = '' then null
    when btrim(label) like '<%'             then 0
    else nullif(regexp_replace(substring(label from '≥([^<]*)'), '\D', '', 'g'), '')::numeric
  end
$$;

-- ---------------------------------------------------------------------------
-- explo_activites : une ligne par activité, toutes les jointures déjà faites
-- ---------------------------------------------------------------------------
create table explo_activites as
with
lien as (   -- activité <-> action de représentation d'intérêts
  select distinct activite_id, action_representation_interet_id as action_id
  from observations
  where activite_id is not null and action_representation_interet_id is not null
),
dom as (
  select activite_id, array_agg(distinct v order by v) as v
  from (select activite_id, btrim(domaines_intervention_actions_menees) v from domaines_intervention) s
  where v <> '' group by 1
),
typ as (
  select l.activite_id, array_agg(distinct btrim(a.action_menee) order by btrim(a.action_menee)) as v
  from lien l join actions_menees a on a.action_representation_interet_id = l.action_id
  where btrim(a.action_menee) <> '' group by 1
),
resp as (
  select activite_id, array_agg(distinct v order by v) as v
  from (select l.activite_id, explo_responsable(m.responsable_public) v
        from lien l join ministeres m on m.action_representation_interet_id = l.action_id) s
  where v is not null group by 1
),
mins as (
  select activite_id, array_agg(distinct v order by v) as v
  from (select l.activite_id, explo_ministere(m.departement_ministeriel) v
        from lien l join ministeres m on m.action_representation_interet_id = l.action_id) s
  where v is not null group by 1
),
deci as (
  select l.activite_id, array_agg(distinct btrim(d.decision_concernee) order by btrim(d.decision_concernee)) as v
  from lien l join decisions_concernees d on d.action_representation_interet_id = l.action_id
  where btrim(d.decision_concernee) <> '' group by 1
),
sect as (
  select representants_id, array_agg(distinct btrim(secteur_activite) order by btrim(secteur_activite)) as v
  from secteurs_activites where btrim(secteur_activite) <> '' group by 1
),
niv as (
  select representants_id, array_agg(distinct btrim(niveau_intervention) order by btrim(niveau_intervention)) as v
  from niveaux_intervention where btrim(niveau_intervention) <> '' group by 1
),
ex as (
  select distinct on (exercices_id) * from exercices where exercices_id is not null order by exercices_id
),
org as (
  select distinct on (representants_id) * from informations_generales where representants_id is not null order by representants_id
),
act as (
  select distinct on (activite_id) * from objets_activites where activite_id is not null order by activite_id
)
select
  a.activite_id,
  e.representants_id,
  a.exercices_id,
  case when e.annee_debut ~ '^\d{4}$' then e.annee_debut::int end                       as annee,
  case when a.date_publication_activite ~ '^\d{4}-\d{2}-\d{2}$'
       then a.date_publication_activite::date end                                      as date_publication,
  a.identifiant_fiche,
  a.objet_activite                                                                      as objet,
  o.denomination,
  nullif(btrim(o.label_categorie_organisation), '')                                     as categorie,
  nullif(btrim(e.montant_depense), '')                                                  as depense,
  nullif(btrim(e.chiffre_affaires), '')                                                 as chiffre_affaires,
  coalesce(dom.v,  '{}')  as domaines,
  coalesce(typ.v,  '{}')  as types_action,
  coalesce(resp.v, '{}')  as responsables,
  coalesce(mins.v, '{}')  as ministeres,
  coalesce(deci.v, '{}')  as decisions,
  coalesce(sect.v, '{}')  as secteurs,
  coalesce(niv.v,  '{}')  as niveaux
from act a
join ex e        on e.exercices_id = a.exercices_id
left join org o  on o.representants_id = e.representants_id
left join dom    on dom.activite_id  = a.activite_id
left join typ    on typ.activite_id  = a.activite_id
left join resp   on resp.activite_id = a.activite_id
left join mins   on mins.activite_id = a.activite_id
left join deci   on deci.activite_id = a.activite_id
left join sect   on sect.representants_id = e.representants_id
left join niv    on niv.representants_id  = e.representants_id;

alter table explo_activites add primary key (activite_id);
create index on explo_activites (representants_id);
create index on explo_activites (annee);
create index on explo_activites (date_publication);
create index on explo_activites (categorie);
create index on explo_activites using gin (domaines);
create index on explo_activites using gin (types_action);
create index on explo_activites using gin (responsables);
create index on explo_activites using gin (ministeres);
create index on explo_activites using gin (decisions);
create index on explo_activites using gin (secteurs);

-- ---------------------------------------------------------------------------
-- explo_organisations : une ligne par organisation, avec ses indicateurs
-- ---------------------------------------------------------------------------
create table explo_organisations as
with
org as (
  select distinct on (representants_id) * from informations_generales where representants_id is not null order by representants_id
),
ex as (
  select representants_id,
         count(*)                                                                   as nb_exercices,
         min(case when annee_debut ~ '^\d{4}$' then annee_debut::int end)           as premiere_annee,
         max(case when annee_debut ~ '^\d{4}$' then annee_debut::int end)           as derniere_annee
  from exercices group by 1
),
dep as (    -- dernière tranche de dépense déclarée
  select distinct on (representants_id) representants_id,
         btrim(montant_depense)                  as depense_recente,
         explo_ordre_tranche(montant_depense)    as depense_recente_ordre,
         nombre_salaries                         as salaries_recent
  from exercices
  where btrim(coalesce(montant_depense, '')) <> '' and annee_debut ~ '^\d{4}$'
  order by representants_id, annee_debut::int desc
),
ca as (
  select distinct on (representants_id) representants_id,
         btrim(chiffre_affaires)                 as ca_recent,
         explo_ordre_tranche(chiffre_affaires)   as ca_recent_ordre
  from exercices
  where btrim(coalesce(chiffre_affaires, '')) <> '' and annee_debut ~ '^\d{4}$'
  order by representants_id, annee_debut::int desc
),
act as (
  select representants_id, count(*) as nb_activites from explo_activites group by 1
),
top_dom as (
  select representants_id, (array_agg(v order by n desc, v))[1:3] as v
  from (select representants_id, unnest(domaines) v, count(*) n from explo_activites group by 1, 2) s group by 1
),
top_min as (
  select representants_id, (array_agg(v order by n desc, v))[1:3] as v
  from (select representants_id, unnest(ministeres) v, count(*) n from explo_activites group by 1, 2) s group by 1
),
sect as (
  select representants_id, array_agg(distinct btrim(secteur_activite) order by btrim(secteur_activite)) as v
  from secteurs_activites where btrim(secteur_activite) <> '' group by 1
),
niv as (
  select representants_id, array_agg(distinct btrim(niveau_intervention) order by btrim(niveau_intervention)) as v
  from niveaux_intervention where btrim(niveau_intervention) <> '' group by 1
),
cli as (select representants_id, count(*) n from clients        group by 1),
col as (select representants_id, count(*) n from collaborateurs group by 1),
dir as (select representants_id, count(*) n from dirigeants     group by 1)
select
  o.representants_id,
  o.denomination,
  nullif(btrim(o.sigle_hatvp), '')                    as sigle,
  nullif(btrim(o.label_categorie_organisation), '')   as categorie,
  nullif(btrim(o.ville), '')                          as ville,
  nullif(btrim(o.code_postal), '')                    as code_postal,
  initcap(nullif(btrim(o.pays), ''))                  as pays,
  nullif(btrim(o.site_web), '')                       as site_web,
  nullif(btrim(o.identifiant_national), '')           as identifiant_national,
  coalesce(sect.v, '{}')                              as secteurs,
  coalesce(niv.v,  '{}')                              as niveaux,
  coalesce(ex.nb_exercices, 0)                        as nb_exercices,
  ex.premiere_annee,
  ex.derniere_annee,
  coalesce(act.nb_activites, 0)                       as nb_activites,
  dep.depense_recente,
  dep.depense_recente_ordre,
  dep.salaries_recent,
  ca.ca_recent,
  ca.ca_recent_ordre,
  coalesce(cli.n, 0)                                  as nb_clients,
  coalesce(col.n, 0)                                  as nb_collaborateurs,
  coalesce(dir.n, 0)                                  as nb_dirigeants,
  coalesce(top_dom.v, '{}')                           as top_domaines,
  coalesce(top_min.v, '{}')                           as top_ministeres
from org o
left join ex      on ex.representants_id      = o.representants_id
left join dep     on dep.representants_id     = o.representants_id
left join ca      on ca.representants_id      = o.representants_id
left join act     on act.representants_id     = o.representants_id
left join top_dom on top_dom.representants_id = o.representants_id
left join top_min on top_min.representants_id = o.representants_id
left join sect    on sect.representants_id    = o.representants_id
left join niv     on niv.representants_id     = o.representants_id
left join cli     on cli.representants_id     = o.representants_id
left join col     on col.representants_id     = o.representants_id
left join dir     on dir.representants_id     = o.representants_id;

alter table explo_organisations add primary key (representants_id);
create index on explo_organisations (categorie);
create index on explo_organisations using gin (secteurs);

-- ---------------------------------------------------------------------------
-- explo_dimensions : les valeurs possibles de chaque dimension (pour les filtres)
-- ---------------------------------------------------------------------------
create table explo_dimensions as
select dim, valeur, count(*) as nb_activites,
       case when dim = 'annee'                         then valeur::numeric
            when dim in ('depense', 'chiffre_affaires') then explo_ordre_tranche(valeur) end as ordre
from (
  select 'domaines'         as dim, unnest(domaines)     as valeur from explo_activites union all
  select 'types_action',            unnest(types_action)           from explo_activites union all
  select 'responsables',            unnest(responsables)           from explo_activites union all
  select 'ministeres',              unnest(ministeres)             from explo_activites union all
  select 'decisions',               unnest(decisions)              from explo_activites union all
  select 'secteurs',                unnest(secteurs)               from explo_activites union all
  select 'niveaux',                 unnest(niveaux)                from explo_activites union all
  select 'categorie',               categorie                      from explo_activites union all
  select 'annee',                   annee::text                    from explo_activites union all
  select 'depense',                 depense                        from explo_activites union all
  select 'chiffre_affaires',        chiffre_affaires               from explo_activites
) s
where valeur is not null
group by dim, valeur;

alter table explo_dimensions add primary key (dim, valeur);

-- ---------------------------------------------------------------------------
-- Sécurité : lecture seule pour le public
-- ---------------------------------------------------------------------------
alter table explo_activites     enable row level security;
alter table explo_organisations enable row level security;
alter table explo_dimensions    enable row level security;
create policy "lecture publique" on explo_activites     for select to anon using (true);
create policy "lecture publique" on explo_organisations for select to anon using (true);
create policy "lecture publique" on explo_dimensions    for select to anon using (true);


-- Statistiques à jour pour le planificateur
analyze explo_activites;
analyze explo_organisations;
analyze explo_dimensions;

-- Demande à l'API de Supabase de voir les nouvelles tables / fonctions
notify pgrst, 'reload schema';
