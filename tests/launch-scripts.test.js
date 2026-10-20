'use strict';

/**
 * Проверка файлов запуска для Windows: `start.ps1`, `stop.ps1`, `check.ps1`,
 * `seed-demo.ps1`.
 *
 * PowerShell 5.1 читает .ps1 без явной кодировки как Windows-1251, поэтому:
 *  - файлы, где обещан ASCII, не должны содержать не-ASCII вовсе;
 *  - start.ps1 ведёт диалог по-русски и обязан лежать с UTF-8 BOM.
 *
 * Вторая проверка - структура файла. Один раз сломанный патч оставил в start.ps1
 * висячий `} else {`, и PowerShell выдал "Имя else не распознано как имя
 * командлета": скрипт упал до запуска сервера. Полноценного парсера здесь нет,
 * но он и не нужен: ловим разбаланс фигурных скобок и `else`/`elseif`, который
 * не относится к только что закрытому блоку `if`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ASCII_PS1 = ['check.ps1', 'stop.ps1', 'seed-demo.ps1'];
const ALL_PS1 = ['start.ps1', ...ASCII_PS1];

const readBuf = (file) => fs.readFileSync(path.join(ROOT, file));

test('check.ps1, stop.ps1 и seed-demo.ps1 - чистый ASCII', () => {
  const problems = [];
  for (const file of ASCII_PS1) {
    const buf = readBuf(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      problems.push(`${file}: BOM не нужен в ASCII-файле`);
    }
    const line = buf.toString('latin1').split('\n').findIndex((l) => /[^\x00-\x7F]/.test(l));
    if (line >= 0) problems.push(`${file}:${line + 1}: не-ASCII символы (Windows PowerShell 5.1 сломается)`);
  }
  assert.deepEqual(problems, []);
});

test('start.ps1 лежит с UTF-8 BOM (иначе кириллица в Win PowerShell 5.1 мусором)', () => {
  const buf = readBuf('start.ps1');
  assert.equal(buf[0], 0xef, 'первые байты: EF BB BF');
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
  assert.ok(buf.slice(3).toString('utf8').includes('param('), 'после BOM должен идти текст скрипта');
});

/**
 * Минимальный сканер PowerShell: пропускает комментарии, строки и here-строки,
 * считает блоки {} и помнит, чем блок открыт (if/elseif/else/цикл/прочее).
 */
function scanPowerShell(source) {
  const KEYWORDS = {
    if: 'if', elseif: 'elseif', else: 'else', switch: 'switch',
    foreach: 'loop', for: 'loop', while: 'loop', do: 'loop', function: 'func',
  };
  const SQ = "'";
  const DQ = '"';
  const errors = [];
  const stack = [];
  let i = 0;
  let line = 1;
  let pending = null;

  const fail = (message) => errors.push(`строка ${line}: ${message}`);

  while (i < source.length) {
    const c = source[i];

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (source.startsWith('<#', i)) {
      const end = source.indexOf('#>', i + 2);
      if (end < 0) {
        fail('незакрытый блок-комментарий <#');
        break;
      }
      line += source.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (c === '#') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('@' + SQ, i) || source.startsWith('@' + DQ, i)) {
      const term = source[i + 1] === SQ ? SQ + '@' : DQ + '@';
      let k = i;
      for (;;) {
        k = source.indexOf(term, k + 1);
        if (k < 0) {
          fail('незакрытая here-строка');
          return errors;
        }
        const lineStart = source.lastIndexOf('\n', k) + 1;
        if (source.slice(lineStart, k).trim() === term) break;
      }
      line += source.slice(i, k).split('\n').length - 1;
      i = k + term.length;
      continue;
    }
    if (c === SQ || c === DQ) {
      let j = i + 1;
      for (;;) {
        if (j >= source.length) {
          fail('незакрытая кавычка');
          return errors;
        }
        if (c === DQ && source[j] === '`') {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          if (c === SQ && source[j + 1] === SQ) {
            j += 2;
            continue;
          }
          break;
        }
        if (source[j] === '\n') line += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') {
      stack.push(pending || 'block');
      pending = null;
      i += 1;
      continue;
    }
    if (c === '}') {
      if (stack.length === 0) {
        fail('лишняя закрывающая }');
        i += 1;
        continue;
      }
      const kind = stack.pop();
      let j = i + 1;
      while (j < source.length && /[ \t\r]/.test(source[j])) j += 1;
      let word = '';
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) {
        word += source[j];
        j += 1;
      }
      const next = word.toLowerCase();
      if ((next === 'else' || next === 'elseif') && kind !== 'if' && kind !== 'elseif') {
        fail(`лишнее "${next}": ближайший блок - "${kind}", а не if/elseif ` +
          '(PowerShell примет else за имя команды)');
      }
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      const word = source.slice(i, j).toLowerCase();
      if (word in KEYWORDS) pending = KEYWORDS[word];
      i = j;
      continue;
    }
    i += 1;
  }

  if (stack.length > 0) fail(`незакрытых блоков осталось: ${stack.length}`);
  return errors;
}

test('структура всех .ps1 цела: скобки сбалансированы, else относится к if', () => {
  const problems = [];
  for (const file of ALL_PS1) {
    const source = readBuf(file).toString('utf8');
    for (const message of scanPowerShell(source)) problems.push(`${file}: ${message}`);
  }
  assert.deepEqual(problems, []);
});

test('start.ps1 решает о сидинге по содержимому базы, а не по наличию файла', () => {
  const start = fs.readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');
  assert.ok(start.includes('scripts/needs-seed.js'), 'нужен вызов needs-seed.js');
  assert.ok(start.includes("--no-warnings scripts/needs-seed.js"), 'вызов без ExperimentalWarning в stderr');
  assert.ok(/\$dbState\s+-eq\s+'populated'/.test(start), 'ветвление по результату проверки');
  const sh = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
  assert.ok(sh.includes('needs-seed'), 'start.sh использует ту же проверку');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/needs-seed.js')), 'скрипт проверки на месте');
});
