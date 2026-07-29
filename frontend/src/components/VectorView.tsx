/**
 * Renders a vector so it can actually be looked at.
 *
 * A list of 1024 floats tells you nothing, and the first four tell you almost nothing.
 * Each component is drawn as a bar from the centre line — sign as direction, magnitude as
 * length — which makes the two things worth seeing visible at a glance: whether the
 * vector is dense or sparse, and whether two vectors have the same shape.
 */
export function VectorView({ vector, height = 44 }: { vector: number[]; height?: number; }) {
    if (!vector.length) {
        return null;
    }

    // Scaled to the largest component, so a truncated 256-dim vector and a full 1024-dim
    // one are equally readable rather than one of them being a flat line.
    const peak = Math.max(...vector.map(Math.abs)) || 1;
    // Beyond a few hundred bars nothing is distinguishable and the DOM gets expensive.
    const step = Math.max(1, Math.ceil(vector.length / 256));
    const shown: number[] = [];
    for (let i = 0; i < vector.length; i += step) {
        shown.push(vector[i]);
    }

    const magnitude = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));

    return (
        <figure className="vector" style={{ margin: 0 }}>
            <div className="vector-plot" style={{ height }} aria-hidden="true">
                {shown.map((value, i) => (
                    <i
                        key={i}
                        className={value >= 0 ? 'up' : 'down'}
                        style={{ height: `${(Math.abs(value) / peak) * 50}%` }}
                    />
                ))}
            </div>
            <figcaption className="vector-meta">
                {vector.length} dims
                {step > 1 ? ` · every ${step}${suffix(step)} shown` : ''}
                {' · '}‖v‖ {magnitude.toFixed(3)}
                {' · '}[{vector.slice(0, 3).map((n) => n.toFixed(3)).join(', ')}, …]
            </figcaption>
        </figure>
    );
}

function suffix(n: number): string {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
}
