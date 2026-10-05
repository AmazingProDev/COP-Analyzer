"""Refresh the bundled data version after replacing the BDD workbook."""

from hashlib import sha256
import json
from pathlib import Path


folder = Path(__file__).resolve().parent
bdd = folder / "BDD_Mensuel_M08.xlsx"
manifest = {
    "version": sha256(bdd.read_bytes()).hexdigest()[:16],
    "bdd": "BDD/BDD_Mensuel_M08.xlsx",
    "sarf": "BDD/SARF%20autoroute%20Rabat%20-%20Casa.xlsx",
}
(folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
