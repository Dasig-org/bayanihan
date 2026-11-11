"""Build packages/server/data/psgc.json from the MIT-licensed `barangay` package (PyPI), which packages the PSA's
Philippine Standard Geographic Code. Run:  python3 tools/psgc/build.py   (downloads the latest wheel)."""
import io, json, urllib.request, zipfile, pathlib
meta = json.load(urllib.request.urlopen("https://pypi.org/pypi/barangay/json"))
wheel = next(u for u in meta["urls"] if u["url"].endswith(".whl"))
z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(wheel["url"]).read()))
rows = json.loads(z.read("barangay/data/barangay_flat.json"))
T = {"region": "r", "province": "p", "highly_urbanized_city": "c", "independent_component_city": "c", "component_city": "c",
     "municipality": "m", "submunicipality": "s", "special_geographic_area": "g", "barangay": "b"}
by = {r["psgc_id"]: r for r in rows}
out = [[r["psgc_id"], r["name"], T.get(r["type"], "x"), r["parent_psgc_id"]] for r in rows]
here = pathlib.Path(__file__).resolve().parents[2] / "packages/server/data"
(here / "psgc.json").write_text(json.dumps({"version": meta["info"]["version"], "places": out}, separators=(",", ":"), ensure_ascii=False))
lic = next(n for n in z.namelist() if n.endswith("LICENSE"))
(here / "PSGC_NOTICE.md").write_text(f"""# Places: Philippine Standard Geographic Code (PSGC)

`psgc.json` lists the Philippines' regions, provinces, cities, municipalities and barangays with their PSGC codes, from the
**Philippine Statistics Authority** (https://psa.gov.ph/classification/psgc), as packaged by the open-source **barangay**
project by Manuel B. (bendlikeabamboo): https://github.com/bendlikeabamboo/barangay-api and https://pypi.org/project/barangay/
(version {meta["info"]["version"]}). Thank you to them and to the civic tech volunteers who keep it current.

Rebuild with `python3 tools/psgc/build.py`. The barangay project's licence:

```
{z.read(lic).decode().strip()}
```
""")
print(len(out), "places", meta["info"]["version"])
