/** Collapse runs of newlines and surrounding whitespace in an HTML attribute value. */
export function cleanAttribute(attribute: string): string {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}
