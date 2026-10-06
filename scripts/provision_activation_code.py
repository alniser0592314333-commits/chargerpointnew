import os
import urllib.request
import urllib.error
import json
import sys

def main():
    token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
    project_ref = os.environ.get('SUPABASE_PROJECT_REF')
    if not project_ref:
        raise RuntimeError('Missing SUPABASE_PROJECT_REF')
    
    code = os.environ.get('SUPABASE_ACTIVATION_CODE') or os.environ.get('ACTIVATION_CODE')
    if not code or not code.strip():
        print('[PROVISIONING STATUS] NOT CONFIGURED.')
        print('Environment secret SUPABASE_ACTIVATION_CODE is not set.')
        print('To provision the initial Activation Code, set SUPABASE_ACTIVATION_CODE in environment secrets and run this script.')
        sys.exit(0)
        
    code = code.strip()
    url = f'https://api.supabase.com/v1/projects/{project_ref}/database/query'
    
    check_sql = 'SELECT count(*) FROM public.activation_codes WHERE is_used = FALSE;'
    req = urllib.request.Request(url, data=json.dumps({'query': check_sql}).encode('utf-8'), headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    })
    
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data and data[0].get('count', 0) > 0:
                print('[PROVISIONING STATUS] ALREADY CONFIGURED.')
                print('An active unconsumed activation code already exists in public.activation_codes.')
                return
    except Exception as e:
        print('[PROVISIONING ERROR] Failed to check activation codes.')
        sys.exit(1)

    clean_code = code.replace("'", "''")
    exec_sql = f"INSERT INTO public.activation_codes (code_hash) VALUES (crypt('{clean_code}', gen_salt('bf', 10)));"
    
    req_insert = urllib.request.Request(url, data=json.dumps({'query': exec_sql}).encode('utf-8'), headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    })
    
    try:
        with urllib.request.urlopen(req_insert) as resp:
            resp.read()
    except Exception as e:
        print('[PROVISIONING ERROR] Failed to insert activation code hash.')
        sys.exit(1)
        
    req_verify = urllib.request.Request(url, data=json.dumps({'query': check_sql}).encode('utf-8'), headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    })
    
    try:
        with urllib.request.urlopen(req_verify) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            count = data[0].get('count', 0) if data else 0
            if count == 1:
                print('[PROVISIONING STATUS] SUCCESSFUL.')
                print('Initial Activation Code has been hashed with bcrypt and provisioned into public.activation_codes.')
                print('Active Unconsumed Codes Count: 1.')
                print('Plaintext code was never logged, printed, or stored.')
            else:
                print('[PROVISIONING ERROR] Expected 1 active code, found:', count)
    except Exception as e:
        print('[PROVISIONING ERROR] Failed to verify activation code count.')
        sys.exit(1)

if __name__ == '__main__':
    main()
