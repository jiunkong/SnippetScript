import { createSnippetError } from './errors.js';
export type TypeName = 'string' | 'number' | 'bool' | 'fragment' | 'list' | 'range' | 'null' | 'undefined' | 'unknown';
const order: readonly TypeName[] = ['string', 'number', 'bool', 'fragment', 'list', 'range', 'null', 'undefined', 'unknown'];
const identities = new WeakMap<Type, number>();
const structuralIds = new Map<string, number>();
function typeIdentity(type: Type): number {
    const cached = identities.get(type);
    if (cached !== undefined) return cached;
    if (type.descriptor !== type) return typeIdentity(type.descriptor);
    if (type instanceof UnionType && type.members.length < 2) return typeIdentity(type.members[0] ?? Types.never);
    const key = type instanceof ListType ? `list:${typeIdentity(type.element)}`
        : type instanceof UnionType ? `union:${type.members.map(typeIdentity).sort((a,b)=>a-b).join(',')}` : type.kind;
    let identity = structuralIds.get(key);
    if (identity === undefined) { identity = structuralIds.size; structuralIds.set(key, identity); }
    identities.set(type, identity);
    return identity;
}

/** Common base for language type descriptions and evaluated language values. */
export abstract class Type {
    constructor() { Object.defineProperty(this, 'descriptor', { value: this, writable: true, configurable: true, enumerable: false }); }
    abstract readonly kind: TypeName | 'union' | 'any' | 'never';
    readonly descriptor!: Type;
    abstract format(): string;
    get identity(): number { return typeIdentity(this); }
    equals(other: Type): boolean { return this.identity === other.identity; }
    union(other: Type): Type { return UnionType.of(this.descriptor, other.descriptor); }
    accepts(other: Type): boolean {
        if (this.descriptor !== this) return this.descriptor.accepts(other.descriptor);
        if (this.kind === 'any' || this.kind === 'unknown' || other.kind === 'never') return true;
        if (other instanceof UnionType) return other.members.every(member => this.accepts(member));
        if (this instanceof UnionType) return this.members.some(member => member.accepts(other));
        if (this instanceof ListType && other.descriptor instanceof ListType) return this.element.accepts((other.descriptor as ListType).element);
        return this.kind === other.kind;
    }
    get names(): readonly TypeName[] {
        return Object.freeze(this instanceof UnionType ? order.filter(name => this.members.some(member => member.kind === name))
            : this.kind === 'any' ? ['unknown'] as TypeName[] : this.kind === 'never' ? [] : [this.kind as TypeName]);
    }
    toJSON(): unknown { return { kind: this.kind }; }
}
class AtomicType extends Type {
    constructor(readonly kind: TypeName) { super(); Object.freeze(this); }
    format() { return this.kind; }
}
export class StringType extends AtomicType { constructor() { super('string'); } }
export class NumberType extends AtomicType { constructor() { super('number'); } }
export class BoolType extends AtomicType { constructor() { super('bool'); } }
export class FragmentType extends AtomicType { constructor() { super('fragment'); } }
export class RangeType extends AtomicType { constructor() { super('range'); } }
export class NullType extends AtomicType { constructor() { super('null'); } }
export class UndefinedType extends AtomicType { constructor() { super('undefined'); } }
export class UnknownType extends AtomicType { constructor() { super('unknown'); } }
export class AnyType extends Type {
    readonly kind = 'any';
    constructor() { super(); Object.freeze(this); }
    format() { return 'any'; }
}
export class NeverType extends Type {
    readonly kind = 'never';
    constructor() { super(); Object.freeze(this); }
    format() { return 'never'; }
}
export class ListType extends Type {
    readonly kind = 'list';
    constructor(readonly element: Type) { super(); Object.freeze(this); }
    format(): string { return `list<${this.element.format()}>`; }
    toJSON(): unknown { return { kind: this.kind, element: this.element }; }
}
export class UnionType extends Type {
    readonly kind = 'union';
    readonly members: readonly Type[];
    constructor(members: readonly Type[]) {
        super();
        const flattened = members.flatMap(member => member.descriptor instanceof UnionType ? (member.descriptor as UnionType).members : [member.descriptor]);
        const top = flattened.find(member => member.kind === 'any') ?? flattened.find(member => member.kind === 'unknown');
        const normalized = top ? [top] : flattened.filter(member => member.kind !== 'never');
        const unique = new Map<number, Type>();
        for (const member of normalized) if (!unique.has(member.identity)) unique.set(member.identity, member);
        this.members = Object.freeze([...unique.values()].sort((a,b) => order.indexOf(a.kind as TypeName) - order.indexOf(b.kind as TypeName) || a.identity - b.identity));
        Object.freeze(this);
    }
    static of(...members: readonly Type[]): Type {
        const union = new UnionType(members);
        if (union.members.some(member => member.kind === 'any')) return Types.any;
        if (union.members.some(member => member.kind === 'unknown')) return Types.unknown;
        return union.members.length === 1 ? union.members[0] : union.members.length ? union : Types.never;
    }
    format(): string {
        return this.members.length ? this.members.map(member => ({ order: order.indexOf(member.kind as TypeName), text: member.format() }))
            .sort((a,b) => a.order - b.order || a.text.localeCompare(b.text)).map(member => member.text).join(' | ') : 'never';
    }
    toJSON(): unknown { return { kind: this.kind, members: this.members }; }
}
export const Types = Object.freeze({
    string: new StringType(), number: new NumberType(), bool: new BoolType(), fragment: new FragmentType(),
    range: new RangeType(), null: new NullType(), undefined: new UndefinedType(), unknown: new UnknownType(),
    any: new AnyType(), never: new NeverType(),
});
export function typeFromNames(names: readonly TypeName[], elements?: readonly TypeName[]): Type {
    return UnionType.of(...names.map(name => name === 'list' ? new ListType(elements ? typeFromNames(elements) : Types.unknown) : Types[name]));
}
/** Legacy names are views for older hosts; the descriptor remains authoritative. */
export function typeInfo(type: Type, exactElements?: boolean) {
    return { type, exactElements,
        get types(): readonly TypeName[] { return type.names; },
        get elements(): readonly TypeName[] | undefined {
            const lists = (type instanceof UnionType ? type.members : [type]).filter((member): member is ListType => member instanceof ListType);
            return lists.length ? UnionType.of(...lists.map(list => list.element)).names : undefined;
        }
    };
}

export abstract class ScriptValue<T = unknown> extends Type {
    abstract readonly value: T;
    abstract readonly descriptor: Type;
    format(): string { return this.descriptor.format(); }
    abstract toString(): string;
    toJSON(): unknown { return { kind: this.kind, value: this.value }; }
    // Force every native conversion to go through the explicit boundary codec.
    [Symbol.toPrimitive](hint: string): string { if (hint === 'string') return this.toString(); throw new TypeError('Use toNative() to convert a script value'); }
}
export class StringValue extends ScriptValue<string> {
    readonly kind = 'string'; readonly descriptor = Types.string;
    constructor(readonly value: string) { super(); if (typeof value !== 'string') throw new TypeError('Expected string payload'); Object.freeze(this); }
    toString() { return this.value; }
}
export class NumberValue extends ScriptValue<number> {
    readonly kind = 'number'; readonly descriptor = Types.number;
    constructor(readonly value: number) { super(); if (typeof value !== 'number') throw new TypeError('Expected number payload'); if (Number.isNaN(value)) throw createSnippetError('err_number_nan'); Object.freeze(this); }
    toString() { return String(this.value); }
}
export class BoolValue extends ScriptValue<boolean> {
    readonly kind = 'bool'; readonly descriptor = Types.bool;
    constructor(readonly value: boolean) { super(); if (typeof value !== 'boolean') throw new TypeError('Expected bool payload'); Object.freeze(this); }
    toString() { return String(this.value); }
}
export class NullValue extends ScriptValue<null> {
    readonly kind = 'null'; readonly descriptor = Types.null; readonly value = null;
    constructor() { super(); Object.freeze(this); }
    toString() { return ''; }
}
export class UndefinedValue extends ScriptValue<undefined> {
    readonly kind = 'undefined'; readonly descriptor = Types.undefined; readonly value = undefined;
    constructor() { super(); Object.freeze(this); }
    toString() { return ''; }
}
export class ListValue extends ScriptValue<readonly ScriptValue[]> {
    readonly kind = 'list'; readonly value: readonly ScriptValue[]; readonly descriptor: ListType;
    constructor(items: readonly ScriptValue[]) {
        super();
        if (items.some(item => !(item instanceof ScriptValue))) throw new TypeError('List items must be script values');
        this.value = Object.freeze([...items]);
        this.descriptor = new ListType(items.length ? UnionType.of(...items.map(item => item.descriptor)) : Types.never);
        Object.freeze(this);
    }
    get length() { return this.value.length; }
    [Symbol.iterator]() { return this.value[Symbol.iterator](); }
    toString(): string { return `[${this.value.map(item => item.kind === 'string' ? JSON.stringify(item.value) : item.kind === 'null' ? 'null' : item.kind === 'undefined' ? 'undefined' : item.toString()).join(',')}]`; }
}
export class RangeValue extends ScriptValue<Readonly<{ start: number; end: number }>> {
    readonly kind = 'range'; readonly type = 'range'; readonly descriptor = Types.range;
    readonly value: Readonly<{ start: number; end: number }>;
    constructor(readonly start: number, readonly end: number) {
        super();
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(Math.abs(end-start)+1)) throw createSnippetError('err_range_integer_bounds');
        this.value = Object.freeze({ start, end }); Object.freeze(this);
    }
    toString() { return `${this.start}~${this.end}`; }
}
export const UNDEFINED = new UndefinedValue(), NULL = new NullValue();
