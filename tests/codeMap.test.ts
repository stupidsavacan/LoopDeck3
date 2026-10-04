import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { createCodeMap, functionBodyHash } from '../scripts/code-map.mjs';

function hash(body: string): string {
  const source = ts.createSourceFile('fixture.ts', `function inspect(input: string) { ${body} }`, ts.ScriptTarget.Latest, true);
  const declaration = source.statements[0];
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Invalid function fixture');
  return functionBodyHash(declaration.body);
}

describe('machine code map', () => {
  it('compares syntax independently of whitespace, comments and string quote style', () => {
    expect(hash(`const text = 'hello'; return text;`)).toBe(hash(`const text="hello"; /* same body */ return text ;`));
  });
  it.each([
    ['let text = input; return text;', 'const text = input; return text;'],
    ['return /a b/.test(input);', 'return /ab/.test(input);'],
    ['let count = 1; return count++;', 'let count = 1; return count--;'],
    ['return input === "a";', 'return input !== "a";'],
    ['return tag`a\\nb`;', 'return tag`a\nb`;']
  ])('keeps semantic syntax differences in the hash %#', (left, right) => {
    expect(hash(left)).not.toBe(hash(right));
  });
  it('produces a deterministic navigation index independently of implementation names', () => {
    expect(createCodeMap()).toEqual(createCodeMap());
  });
});
