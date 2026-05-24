// ============================================================================
// nome_parametrico.scad — NameForge
// ============================================================================

// ── Texte ────────────────────────────────────────────────────────────────────
nome                 = "Jason";
font_base            = "Bebas Neue:style=Regular";
font_corsivo         = "Pacifico:style=Regular";
mostra_base          = 1;
mostra_nome          = 1;

// ── Dimensions (mm) ──────────────────────────────────────────────────────────
altezza_base         = 20;
profondita_incisione = 4;   // 0 = nom affleurant, N = N mm de profondeur
dimensione_lettera   = 150;
dimensione_nome      = 18;
altezza_nome_solido  = 7;   // hauteur totale du bloc nom (incrusté + dépassement)
offset_nome_x        = 0;
offset_nome_y        = 0;
tolleranza           = 0.1;
margine_taglio       = 10;

// nome_preview_z : Z de départ du nom
// preview  : altezza_base - profondita_incisione → nom dans le creux
// export   : 0 → chemin base_avec_nom_export
nome_preview_z       = 0;

// incidi_preview : 1 = générer base avec creux visible
incidi_preview       = 0;

// taglio_base : mm à retirer depuis le bas du bounding box de la lettre
// 0 = pas de coupe (courbe conservée), 30 = coupe haute (lettre très plate)
taglio_base          = 10;

// ── Couleurs ─────────────────────────────────────────────────────────────────
colore_base          = [0.914, 0.580, 0.965];
colore_nome          = [1.000, 1.000, 1.000];

// chanfrein_haut_mm : bord supérieur chanfreiné (biseauté à 45°)
// 0 = désactivé ; ex. 1.5 = chanfrein de 1.5 mm
chanfrein_haut_mm    = 0;

// ── Qualité ──────────────────────────────────────────────────────────────────
$fa = 4;
$fs = 0.4;

// ── Assertions de sécurité ───────────────────────────────────────────────────
assert(len(nome) > 0,
  "Le texte ne peut pas être vide");
assert(profondita_incisione < altezza_base,
  "profondita_incisione doit être < altezza_base");
assert(chanfrein_haut_mm == 0 || chanfrein_haut_mm < altezza_base,
  "chanfrein_haut_mm doit être < altezza_base");
assert(chanfrein_haut_mm == 0 || chanfrein_haut_mm < dimensione_lettera / 2,
  "chanfrein_haut_mm trop grand par rapport à la taille de la lettre");
assert(taglio_base >= 0 && taglio_base < dimensione_lettera * 0.5,
  "taglio_base doit être dans [0, dimensione_lettera/2[");

// ============================================================================
// Modules
// ============================================================================

// Lettre avec bas plat : intersection 3D pour couper la courbe du bas
// taglio_base = 0 → pas de coupe ; taglio_base = 30 → coupe 30 mm depuis le bas
// chanfrein_haut_mm > 0 → biseau 45° sur le bord supérieur
module forme_base() {
    module lettera_2d() {
        text(nome[0],
             size   = dimensione_lettera,
             font   = font_base,
             halign = "center",
             valign = "center");
    }

    module corps() {
        if (chanfrein_haut_mm > 0 && chanfrein_haut_mm < altezza_base) {
            // Parois droites jusqu'à (altezza_base - c), puis biseau sur c mm
            let (c         = chanfrein_haut_mm,
                 scale_top = max(0.01, 1 - 2 * chanfrein_haut_mm / dimensione_lettera)) {
                union() {
                    linear_extrude(height = altezza_base - c, convexity = 10)
                        lettera_2d();
                    translate([0, 0, altezza_base - c])
                        linear_extrude(height = c, convexity = 10, scale = scale_top)
                            lettera_2d();
                }
            }
        } else {
            linear_extrude(height = altezza_base, convexity = 10)
                lettera_2d();
        }
    }

    intersection() {
        corps();
        translate([-dimensione_lettera,
                   -dimensione_lettera * 0.5 + taglio_base,
                   -1])
            cube([dimensione_lettera * 2, dimensione_lettera * 1.5, altezza_base + 2]);
    }
}

module shape_nom() {
    text(nome,
         size   = dimensione_nome,
         font   = font_corsivo,
         halign = "center",
         valign = "center");
}

// Base seule
module base_seule() {
    color(colore_base)
    forme_base();
}

// Base avec creux incrusté visible (pour preview et affichage sans nom)
module base_incisa() {
    color(colore_base)
    difference() {
        forme_base();
        translate([offset_nome_x, offset_nome_y,
                   altezza_base - profondita_incisione + tolleranza])
            linear_extrude(height = profondita_incisione + tolleranza,
                           convexity = 10)
                shape_nom();
    }
}

// Nom seul — Z départ = nome_preview_z, hauteur = altezza_nome_solido
// altezza_nome_solido - profondita_incisione = mm qui dépassent au-dessus du J
module nom_seul() {
    color(colore_nome)
    translate([offset_nome_x, offset_nome_y, nome_preview_z])
        linear_extrude(height = altezza_nome_solido, convexity = 10)
            shape_nom();
}

// Export impression multicolor : creux + bloc nom flush
module base_avec_nom_export() {
    color(colore_base)
    difference() {
        forme_base();
        translate([offset_nome_x, offset_nome_y,
                   altezza_base - profondita_incisione + tolleranza])
            linear_extrude(height = profondita_incisione + tolleranza,
                           convexity = 10)
                shape_nom();
    }
    color(colore_nome)
    translate([offset_nome_x, offset_nome_y,
               altezza_base - profondita_incisione])
        linear_extrude(height = profondita_incisione, convexity = 10)
            shape_nom();
}

// ============================================================================
// Assemblage
// ============================================================================

if (mostra_base && mostra_nome) {
    if (nome_preview_z > 0) {
        if (incidi_preview) base_incisa(); else base_seule();
        nom_seul();
    } else {
        base_avec_nom_export();
    }
}
else if (mostra_base) {
    // Export mode (nome_preview_z==0) : toujours creuser — sinon le creux disparaît
    if (nome_preview_z == 0 || incidi_preview) base_incisa(); else base_seule();
}
else if (mostra_nome) {
    if (nome_preview_z == 0) {
        // Export standalone : hauteur = profondita_incisione pour s'emboîter exactement dans le creux
        color(colore_nome)
        translate([offset_nome_x, offset_nome_y, 0])
            linear_extrude(height = profondita_incisione, convexity = 10)
                shape_nom();
    } else {
        nom_seul();
    }
}
else {
    echo("AVERTISSEMENT: mostra_base=0 ET mostra_nome=0 — rien à générer.");
}
