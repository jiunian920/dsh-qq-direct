"""Anan-owned memory discovery. Never scans other actors or arbitrary disks."""
import hashlib,json,os,pathlib,re
MEMORY=pathlib.Path(os.environ.get('QQ_MEMORY_DOCUMENTS', pathlib.Path(__file__).resolve().parent.parent/'documents'))
def expanded(config):
    config={**config,'anan':[dict(x) for x in config.get('anan',[])]}
    specs=config['anan']
    base=normalize(MEMORY)
    specs[:]=[s for s in specs if not (s['type']=='document' and (normalize(s['path'])==base or normalize(s['path']).startswith(base+'/')))]
    for spec in specs:
        if spec['type']=='dsh':
            spec['owner_workspace_roots']=list(dict.fromkeys(spec.get('owner_workspace_roots',[])+spec.get('owner_workspaces',[])+[]))
            spec['owner_preset_prefixes']=list(dict.fromkeys(spec.get('owner_preset_prefixes',[])+['whale-','anan-','qq-']))
    # Existing specific specs stay intact; the recursive source catches new modules.
    specs.append({'type':'document','path':str(MEMORY),'glob':'*','recursive':True,'auto_memory':True})
    return config
def normalize(value):return str(value).replace('\\','/').rstrip('/').lower()
def owned(header,spec):
    cwd=normalize(header.get('cwd',''));preset=str(header.get('agentPreset',''))
    exact=cwd in [normalize(x) for x in spec.get('owner_workspaces',[])]
    roots=any(cwd==normalize(x) or cwd.startswith(normalize(x)+'/') for x in spec.get('owner_workspace_roots',[]))
    role=preset in spec.get('owner_presets',['standard']) or any(preset.startswith(x) for x in spec.get('owner_preset_prefixes',[]))
    return bool(role and (exact or roots))
def accepts(file,base,spec):
    if not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(base.resolve()):return False
    if not spec.get('auto_memory'):return True
    relative=file.relative_to(base)
    return file.suffix.lower() in ('.md','.txt') and not any(x.lower() in ('backup','backups','.git','__pycache__') for x in relative.parts) and not re.search(r'credential|password|secret|token|凭据|密码|密钥',file.name,re.I)
def fingerprint(spec):return hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
