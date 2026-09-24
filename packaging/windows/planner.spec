# PyInstaller recipe for the Windows download.
# Build the interface first (frontend/dist), then from the repository root:
#   pyinstaller packaging/windows/planner.spec
# Output: dist/Storage Adequacy Planner/Storage Adequacy Planner.exe (+ _internal/)
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH).parents[1]
name = "Storage Adequacy Planner"

analysis = Analysis(
    [str(root / "packaging" / "windows" / "launcher.py")],
    pathex=[str(root)],
    datas=[
        (str(root / "frontend" / "dist"), "frontend/dist"),
        (str(root / "examples" / "synthetic_fy2029_30.csv"), "examples"),
    ],
    hiddenimports=collect_submodules("uvicorn") + ["python_multipart"],
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name=name,
    icon=str(root / "packaging" / "windows" / "icon.ico"),
    console=True,
)
COLLECT(exe, analysis.binaries, analysis.datas, name=name)
