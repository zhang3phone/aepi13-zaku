"""Best-effort public-package scanner; never a security-audit guarantee."""
import pathlib,re,hashlib,sys,json
ROOT=pathlib.Path(__file__).resolve().parents[1]
EXCLUDE={'.git','node_modules','vendor','storage','backups','private','__pycache__'}
BLOCKED=set(['7c5639b5b10a847dd79fd9ec544d5501fe8286563a023ced8c77a057d9237e83', '1600f940dfac35a2932098bd842f79d95de07cb70c39b5e9c3be4ede8ac5145e', 'bf45c5588359bd8b4a454296cff0baeb2cdceb5cfa0b20fc0e1eec3c7f9c1a1b', '4ca62540120ae76860a87640d169352124b77a80830ef4a2175e7cf303c871ad'])
issues=[];checked=0
for p in ROOT.rglob('*'):
 if not p.is_file() or any(x in EXCLUDE for x in p.relative_to(ROOT).parts) or p.name=='.local-login.txt' or p.name.startswith('.env') and p.name!='.env.example':continue
 checked+=1;rel=str(p.relative_to(ROOT))
 if p.suffix in {'.key','.enc','.dump','.zip','.log','.sql'}:issues.append([rel,'unexpected_private_artifact']);continue
 try:s=p.read_text()
 except UnicodeDecodeError:issues.append([rel,'unexpected_binary']);continue
 if any(hashlib.sha256(w.lower().encode()).hexdigest() in BLOCKED for w in re.findall(r'[A-Za-z]+',s)):issues.append([rel,'private_name'])
 if re.search(r'\b(?:192[.]168[.]\d+[.]\d+|10[.]\d+[.]\d+[.]\d+|172[.](?:1[6-9]|2\d|3[01])[.]\d+[.]\d+)\b',s):issues.append([rel,'private_network'])
 if re.search(r'/(?:Users|Volumes)/[^\s\x22\x27<>]+|[a-z0-9-]+[.]ts[.]net',s,re.I):issues.append([rel,'private_path_or_host'])
 if re.search(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|EAA[A-Za-z0-9]{35,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY',s):issues.append([rel,'credential_pattern'])
 for ident in re.findall(r'(?<![A-Za-z0-9])\d{13,20}(?![A-Za-z0-9])',s):
  if not ident.startswith('900000'):issues.append([rel,'non_demo_long_identifier']);break
print(json.dumps({'checkedFiles':checked,'issues':issues,'scope':'publication source; generated local state and dependencies excluded','warning':'Pattern scan plus manual review; not proof of complete anonymity or security.'},ensure_ascii=False,indent=2))
sys.exit(bool(issues))
