from pathlib import Path
import subprocess
import os,shutil
p=Path(__file__).resolve().parent
b=p/'fixtures'
socket=Path(os.environ['ORB_NATIVE_SOCKET'])
pg=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
args=[str(pg/'psql'),'-X','-q','-h',str(socket),'-p',os.environ.get('ORB_NATIVE_PORT','55931'),'-U','postgres','-v','ON_ERROR_STOP=1']
cache=(p/'cache-behavior-native.sql').read_text()
s=(socket/'finite245-raw-composition.sql').read_text().split('DO $test$DECLARE old jsonb;')[0]+cache+'ROLLBACK;'
log=socket/'finite-generation-cache-native.log'
with log.open('w') as capture:r=subprocess.run(args+['-d','original_source_refs'],input=s,text=True,stdout=capture,stderr=subprocess.STDOUT)
print(r.returncode,log.read_text()[-2500:]);raise SystemExit(r.returncode)
