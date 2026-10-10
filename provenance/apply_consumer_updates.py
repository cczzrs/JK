"""Apply the reviewed, hash-guarded consumer documentation migration once."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
plan = json.loads((ROOT / 'provenance/consumer-update-plan.json').read_text())
allowed = {'ModelShow', 'JK_NET', 'JK_LOGIC', 'JK_BASE', 'JK_SZSB', 'jk-3d-network'}
for item in plan:
    path = Path(item['path'])
    relative = path.relative_to(ROOT.parent)
    assert relative.parts[0] in allowed and len(relative.parts) > 1
    assert not any(p.startswith('.') for p in relative.parts)
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    assert actual == item['old_sha256'], f'Concurrent change: {path}'
    assert not path.is_symlink(), f'Symlink not expected: {path}'
receipts = []
for item in plan:
    path = Path(item['path'])
    if path.exists():
        backup = ROOT / 'provenance/consumer-originals' / path.relative_to(ROOT.parent)
        backup.parent.mkdir(parents=True, exist_ok=True)
        with backup.open('xb') as f:
            f.write(path.read_bytes())
    path.write_text(item['new_content'], encoding='utf-8')
    receipts.append({'path': str(path), 'before_sha256': item['old_sha256'],
        'after_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
(ROOT / 'provenance/consumer-update-receipts.json').write_text(
    json.dumps(receipts, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'updated': len(receipts), 'consumers': sorted(allowed)}, ensure_ascii=False))
