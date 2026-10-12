from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

root = Path(SPECPATH).parents[1]
datas, binaries, hidden = [], [], collect_submodules('server')
for name in ('sherpa_onnx', 'soundfile', '_soundfile_data', 'imageio_ffmpeg', 'keyring'):
    data, binary, modules = collect_all(name)
    datas += data
    binaries += binary
    hidden += modules
hidden += ['keyring.backends.macOS', 'uvicorn.logging', 'uvicorn.loops.asyncio',
           'uvicorn.protocols.http.h11_impl', 'uvicorn.lifespan.on']
for name in ('keyring', 'imageio-ffmpeg', 'sherpa-onnx', 'partial-json-parser'):
    datas += copy_metadata(name)

a = Analysis([str(root / 'services/companion/desktop_entry.py')],
             pathex=[str(root / 'services/companion')], binaries=binaries, datas=datas,
             hiddenimports=hidden, excludes=['pytest', 'tkinter', 'IPython', 'matplotlib'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='companion-service',
          debug=False, strip=False, upx=False, console=True, target_arch='arm64')
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='companion-service')
