#!/usr/bin/env python3
"""zip 打包：把 zen-api-final 打成 Downloads/zen-api-final.zip

用法: python _zip.py <源目录> <输出zip> <根目录名>
"""

import os
import sys
import zipfile

EXCLUDE_DIRS = {'.git', 'node_modules', '.workbuddy', '__pycache__'}
EXCLUDE_FILES = {'.DS_Store'}


def main():
    src, out, root_name = sys.argv[1], sys.argv[2], sys.argv[3]
    files = []
    for root, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for n in sorted(names):
            if n in EXCLUDE_FILES or n.endswith(('.pyc', '.log')):
                continue
            p = os.path.join(root, n)
            files.append((p, os.path.relpath(p, src).replace(os.sep, '/')))
    files.sort(key=lambda x: x[1])
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, arc in files:
            entry = (root_name + '/' + arc) if root_name else arc
            z.write(full, entry)
    print(f'PACKED {len(files)} files -> {out}')
    for _, arc in files:
        print('   ' + arc)


if __name__ == '__main__':
    main()
