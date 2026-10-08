const fs = require('fs');
const path = require('path');

function patchFile(fullPath, replacements) {
  if (!fs.existsSync(fullPath)) return;
  let content = fs.readFileSync(fullPath, 'utf8');
  let modified = false;
  for (const [target, replacement] of replacements) {
    if (content.includes(target)) {
      content = content.replace(target, replacement);
      modified = true;
    }
  }
  if (modified) {
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

function runPatch() {
  const dirs = [
    path.resolve(__dirname, '../node_modules/exceljs'),
    path.resolve(__dirname, '../apps/manager/node_modules/exceljs'),
    path.resolve(__dirname, '../apps/superadmin/node_modules/exceljs'),
    path.resolve(__dirname, '../packages/ui/node_modules/exceljs'),
  ];

  for (const base of dirs) {
    if (!fs.existsSync(base)) continue;

    // 1. lib/xlsx/xlsx.js
    patchFile(path.join(base, 'lib/xlsx/xlsx.js'), [
      [
        '(drawing.anchors || []).forEach(anchor => {',
        '((drawing && drawing.anchors) || []).forEach(anchor => {'
      ]
    ]);

    // 2. lib/xlsx/xform/sheet/worksheet-xform.js
    patchFile(path.join(base, 'lib/xlsx/xform/sheet/worksheet-xform.js'), [
      [
        '        const drawingName = match[1];\n        const drawing = options.drawings[drawingName];\n        drawing.anchors.forEach(anchor => {',
        '        const drawingName = match[1];\n        const drawing = options.drawings && options.drawings[drawingName];\n        if (drawing && drawing.anchors) drawing.anchors.forEach(anchor => {'
      ],
      [
        '        drawing.anchors.forEach(anchor => {',
        '        if (drawing && drawing.anchors) drawing.anchors.forEach(anchor => {'
      ]
    ]);

    // 3. dist/es5/xlsx/xlsx.js
    patchFile(path.join(base, 'dist/es5/xlsx/xlsx.js'), [
      [
        '(drawing.anchors || []).forEach(function (anchor) {',
        '((drawing && drawing.anchors) || []).forEach(function (anchor) {'
      ]
    ]);

    // 4. dist/es5/xlsx/xform/sheet/worksheet-xform.js
    patchFile(path.join(base, 'dist/es5/xlsx/xform/sheet/worksheet-xform.js'), [
      [
        '        const drawingName = match[1];\n        const drawing = options.drawings[drawingName];\n        drawing.anchors.forEach(anchor => {',
        '        const drawingName = match[1];\n        const drawing = options.drawings && options.drawings[drawingName];\n        if (drawing && drawing.anchors) drawing.anchors.forEach(anchor => {'
      ],
      [
        '        drawing.anchors.forEach(function (anchor) {',
        '        if (drawing && drawing.anchors) drawing.anchors.forEach(function (anchor) {'
      ]
    ]);

    // 5. dist/exceljs.js
    patchFile(path.join(base, 'dist/exceljs.js'), [
      [
        '(drawing.anchors || []).forEach(anchor => {',
        '((drawing && drawing.anchors) || []).forEach(anchor => {'
      ],
      [
        'drawing.anchors.forEach(anchor => {',
        'if (drawing && drawing.anchors) drawing.anchors.forEach(anchor => {'
      ]
    ]);

    // 6. dist/exceljs.bare.js
    patchFile(path.join(base, 'dist/exceljs.bare.js'), [
      [
        '(drawing.anchors || []).forEach(anchor => {',
        '((drawing && drawing.anchors) || []).forEach(anchor => {'
      ],
      [
        'drawing.anchors.forEach(anchor => {',
        'if (drawing && drawing.anchors) drawing.anchors.forEach(anchor => {'
      ]
    ]);

    // 7. dist/exceljs.min.js
    patchFile(path.join(base, 'dist/exceljs.min.js'), [
      [
        't.drawings[r].anchors.forEach(',
        '(t.drawings[r]&&t.drawings[r].anchors||[]).forEach('
      ],
      [
        '(r.anchors||[]).forEach(',
        '(r&&r.anchors||[]).forEach('
      ]
    ]);
  }
}

runPatch();
