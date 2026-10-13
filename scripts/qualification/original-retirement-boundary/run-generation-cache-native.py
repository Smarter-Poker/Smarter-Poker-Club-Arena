from pathlib import Path
import subprocess
import os,shutil
p=Path(__file__).resolve().parent
b=p/'fixtures'
socket=Path(os.environ['ORB_NATIVE_SOCKET'])
pg=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
args=[str(pg/'psql'),'-X','-q','-h',str(socket),'-p',os.environ.get('ORB_NATIVE_PORT','55931'),'-U','postgres','-v','ON_ERROR_STOP=1']
s=(socket/'finite245-raw-composition.sql').read_text().split('DO $test$DECLARE old jsonb;')[0]+(p/'cache-behavior-native.sql').read_text()+'ROLLBACK;'
r=subprocess.run(args+['-d','original_source_refs'],input=s,text=True,capture_output=True);(socket/'finite-generation-cache-native.log').write_text(r.stdout+r.stderr);print(r.returncode,(r.stdout+r.stderr)[-1500:]);raise SystemExit(r.returncode)
