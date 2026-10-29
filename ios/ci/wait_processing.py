# Waits until Apple has finished processing this build, so "done" means "installable in TestFlight".
# Usage: python3 wait_processing.py <bundle id> <build number>   (env: KID, ISS, KEY_PATH)
import json, os, sys, time, urllib.request
import jwt  # pyjwt

bundle, build = sys.argv[1], sys.argv[2]
key = open(os.environ['KEY_PATH']).read()

def get(path):
    token = jwt.encode({'iss': os.environ['ISS'], 'iat': int(time.time()), 'exp': int(time.time()) + 600, 'aud': 'appstoreconnect-v1'},
                       key, algorithm='ES256', headers={'kid': os.environ['KID']})
    req = urllib.request.Request('https://api.appstoreconnect.apple.com/v1/' + path, headers={'Authorization': f'Bearer {token}'})
    return json.load(urllib.request.urlopen(req, timeout=30))

app = get(f'apps?filter[bundleId]={bundle}&fields[apps]=bundleId')['data'][0]['id']
start, state = time.time(), 'NOT_SEEN'
while time.time() - start < 45 * 60:
    data = get(f'builds?filter[app]={app}&filter[version]={build}&fields[builds]=processingState,version')['data']
    state = data[0]['attributes']['processingState'] if data else 'NOT_SEEN'
    print(f'{int(time.time() - start)}s: build {build} {state}', flush=True)
    if state in ('VALID', 'FAILED', 'INVALID'):
        break
    time.sleep(30)
mins = round((time.time() - start) / 60, 1)
with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as f:
    f.write(f'Build {build}: Apple processing {state} after {mins} min\n')
sys.exit(0 if state == 'VALID' else 1)
