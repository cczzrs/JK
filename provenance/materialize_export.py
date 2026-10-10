"""One-time materialization of the saved 2026-10-03 export. Never overwrites files."""
from pathlib import Path
import hashlib
import json
import os
import re

ROOT = Path(__file__).resolve().parents[1]
source = json.loads((ROOT / 'provenance/space-export-2026-10-03.json').read_text())
mapping = json.loads((ROOT / 'provenance/migration-map.json').read_text())
reads = json.loads((ROOT / 'provenance/attachment-reads-2026-10-03.json').read_text())
asset_paths = [
    'assets/logic-units/original8/minimal_gate_structures.json',
    'assets/logic-units/original8/verify.py',
    'assets/logic-units/original8/results.json',
    'assets/logic-units/complete11/minimal_boolean_structures11.json',
    'assets/logic-units/complete11/verify.py',
    'assets/logic-units/complete11/results_stage1_complete.json',
    'assets/counters/counter-and-transition-models.json',
    'assets/counters/verification-report.json',
    'provenance/missing-design-evidence-2026-10-01.md',
    'assets/static-prototypes/async-buffer-43-q39-q41.json',
]

def save(path, value):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as f:
        f.write(value.encode('utf-8'))

def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

manifest = {'schema_version': 1, 'migration_date': '2026-10-03',
            'source_space_id': source['space']['id'],
            'content_status': '8 pages and 9 of 10 referenced attachments exported',
            'pages': [], 'attachments': []}
refs = {}
for read, path in zip(reads, asset_paths):
    response = read['response']
    record = {k: read[k] for k in ('page_id', 'label', 'reference')}
    record['path'] = path
    refs[read['reference']] = path
    if response.get('isError'):
        record.update(status='unavailable', error=response['content'][0]['text'])
        text = '# 未迁入的历史证据包\n\n“JK设计与验证材料 2026-10-01”被计数器与异步原型两页引用。2026-10-03 读取附件失败，Chrome 下载尝试也未取得文件。限定检查本地 JK_NET、JK_LOGIC 材料目录，未找到可确认身份的副本。\n\n'
        text += '原引用：`' + read['reference'] + '`。\n\n'
        text += '保留此记录以明确迁移缺口；现有九个附件不能代替或冒充原证据包。原页面与附件引用保留，取得原文件后再补入、核对内容和 SHA-256。\n'
        save(path, text)
    else:
        assert len(response['content']) == 2 and response['content'][1]['type'] == 'text'
        text = response['content'][1]['text']
        save(path, text)
        record.update(status='exported', sha256=sha(text), bytes=len(text.encode('utf-8')))
    manifest['attachments'].append(record)

inventory = {item['page_id']: item for item in source['inventory']}

def transform_prose(markdown, path):
    """Retarget prose while keeping historical fenced examples unchanged."""
    replacements = list(mapping['authority_replacements'])
    for page_id, target in mapping['pages'].items():
        replacements.append(('https://chatgpt.com/space/' + page_id,
                             os.path.relpath(ROOT / target, (ROOT / path).parent)))
    for reference, target in refs.items():
        replacements.append((reference, os.path.relpath(ROOT / target, (ROOT / path).parent)))
    lines = []
    fence = None
    for line in markdown.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line.rstrip('\r\n'))
        if fence is not None:
            lines.append(line)
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= fence[1] and not marker[2].strip():
                fence = None
        elif marker:
            fence = (marker[1][0], len(marker[1]))
            lines.append(line)
        else:
            for old, new in replacements:
                line = line.replace(old, new)
            lines.append(line)
    return ''.join(lines)

for page in source['pages']:
    c = page['content']
    page_id = c['page_id']
    path = mapping['pages'][page_id]
    original = c['markdown']
    original_path = 'provenance/original-pages/' + page_id + '.md'
    save(original_path, original)
    body = transform_prose('\n\n'.join(block['markdown'] for block in c['blocks']), path)
    header = '# ' + c['title'] + '\n\n'
    header += '> 现行主源：本地 JK 项目。2026-10-03 从 JK 空间迁入；原文、块元数据与来源版本保存在 provenance。后续规则在本项目维护。原有历史验证日期与范围保持不变。\n\n'
    local = header + body + '\n'
    save(path, local)
    manifest['pages'].append({'source_page_id': page_id, 'title': c['title'],
        'parent_page_id': (inventory[page_id].get('parent') or {}).get('page_id'),
        'source_sequence': inventory[page_id]['current_sequence'],
        'source_url': page['metadata']['url'], 'path': path, 'original_path': original_path,
        'source_sha256': sha(original), 'migration_sha256': sha(local),
        'block_count': len(c['blocks'])})
save('provenance/migration-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'pages': len(manifest['pages']), 'attachments': len(manifest['attachments']),
                  'exported': sum(a['status']=='exported' for a in manifest['attachments'])}))
