// jsdom ships no type definitions; declare just the surface this project uses.
declare module 'jsdom' {
    import EventEmitter from 'events';

    export class JSDOM {
        constructor(html: string, options?: any);
        window: typeof window;
    }

    export class VirtualConsole extends EventEmitter {
        constructor();
        sendTo(console: any, options?: any): void;
    }
}
