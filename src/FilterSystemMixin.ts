import {TextureSystem, FilterSystem, BaseTexture, RenderTexture, Filter, FilterState} from '@pixi/core';
import {CLEAR_MODES} from '@pixi/constants';
import {Matrix, Rectangle} from '@pixi/math';
import {DisplayObject} from '@pixi/display';
import {BackdropFilter} from "./BlendFilter";

export interface IPictureFilterSystem extends FilterSystem {
    prepareBackdrop(sourceFrame: Rectangle, flipY: Float32Array): RenderTexture;

    pushWithCheck(target: DisplayObject, filters: Array<Filter>, checkEmptyBounds?: boolean): boolean;
}

export interface IPictureTextureSystem extends TextureSystem {
    bindForceLocation(texture: BaseTexture, location: number): void;
}

function containsRect(rectOut: Rectangle, rectIn: Rectangle): boolean {
    let r1 = rectIn.x + rectIn.width;
    let b1 = rectIn.y + rectIn.height;
    let r2 = rectOut.x + rectOut.width;
    let b2 = rectOut.y + rectOut.height;
    return (rectIn.x >= rectOut.x) &&
        (rectIn.x <= r2) &&
        (rectIn.y >= rectOut.y) &&
        (rectIn.y <= b2) &&
        (r1 >= rectOut.x) &&
        (r1 <= r2) &&
        (b1 >= rectOut.y) &&
        (b1 <= b2);
}

function bindForceLocation(this: IPictureTextureSystem, texture: BaseTexture, location = 0) {
    const { gl } = this;
    if (this.currentLocation !== location)
    {
        this.currentLocation = location;
        gl.activeTexture(gl.TEXTURE0 + location);
    }
    this.bind(texture, location);
}

const tempMatrix = new Matrix();

function pushWithCheck(this: IPictureFilterSystem,
              target: DisplayObject, filters: Array<BackdropFilter>, checkEmptyBounds: boolean = true) {
    const renderer = this.renderer;
    const filterStack = this.defaultFilterStack;
    const state = this.statePool.pop() || new FilterState();
    const renderTextureSystem = this.renderer.renderTexture;

    let resolution = filters[0].resolution;
    let padding = filters[0].padding;
    let autoFit = filters[0].autoFit;
    let legacy = filters[0].legacy;

    for (let i = 1; i < filters.length; i++)
    {
        const filter = filters[i];

        resolution = Math.min(resolution, filter.resolution);
        padding = this.useMaxPadding
            ? Math.max(padding, filter.padding)
            : padding + filter.padding;
        autoFit = autoFit && filter.autoFit;

        legacy = legacy || filter.legacy;
    }

    if (filterStack.length === 1)
    {
        this.defaultFilterStack[0].renderTexture = renderTextureSystem.current;
    }

    filterStack.push(state);

    state.resolution = resolution;

    state.legacy = legacy;

    state.target = target;
    state.sourceFrame.copyFrom(target.filterArea || target.getBounds(true));

    state.sourceFrame.pad(padding);

    let canUseBackdrop = true;
    if (autoFit)
    {
        const sourceFrameProjected = (this as any).tempRect.copyFrom(renderTextureSystem.sourceFrame);

        // Project source frame into world space (if projection is applied)
        if (renderer.projection.transform)
        {
            (this as any).transformAABB(
                tempMatrix.copyFrom(renderer.projection.transform).invert(),
                sourceFrameProjected
            );
        }

        state.sourceFrame.fit(sourceFrameProjected);
    } else {
        //check if backdrop is obtainable after rejecting autoFit
        canUseBackdrop = containsRect(this.renderer.renderTexture.sourceFrame, state.sourceFrame);
    }

    if (checkEmptyBounds && state.sourceFrame.width <= 1 && state.sourceFrame.height <= 1) {
        filterStack.pop();
        state.clear();
        this.statePool.push(state);
        return false;
    }
    (this as any).roundFrame(
        state.sourceFrame,
        renderTextureSystem.current ? renderTextureSystem.current.resolution : renderer.resolution,
        renderTextureSystem.sourceFrame,
        renderTextureSystem.destinationFrame,
        renderer.projection.transform,
    );

    // round to whole number based on resolution
    state.sourceFrame.ceil(resolution);

    // detect backdrop uniform
    if (canUseBackdrop) {
        let backdrop = null;
        let backdropFlip = null;
        for (let i = 0; i < filters.length; i++) {
            const bName = filters[i].backdropUniformName;
            if (bName) {
                const { uniforms } = filters[i];
                if (!uniforms[bName + '_flipY']) {
                    uniforms[bName + '_flipY'] = new Float32Array([0.0, 1.0]);
                }
                const flip = uniforms[bName + '_flipY'];
                if (backdrop === null) {
                    backdrop = this.prepareBackdrop(state.sourceFrame, flip);
                    backdropFlip = flip;
                } else {
                    flip[0] = backdropFlip[0];
                    flip[1] = backdropFlip[1];
                }

                uniforms[bName] = backdrop;
                if (backdrop) {
                    filters[i]._backdropActive = true;
                }
            }
        }

        if (backdrop)
        {
            resolution = state.resolution = backdrop.resolution;
        }
    }

    state.renderTexture = this.getOptimalFilterTexture(state.sourceFrame.width, state.sourceFrame.height, resolution);
    state.filters = filters;

    state.destinationFrame.width = state.renderTexture.width;
    state.destinationFrame.height = state.renderTexture.height;

    const destinationFrame = (this as any).tempRect;

    destinationFrame.x = 0;
    destinationFrame.y = 0;
    destinationFrame.width = state.sourceFrame.width;
    destinationFrame.height = state.sourceFrame.height;

    state.renderTexture.filterFrame = state.sourceFrame;
    state.bindingSourceFrame.copyFrom(renderTextureSystem.sourceFrame);
    state.bindingDestinationFrame.copyFrom(renderTextureSystem.destinationFrame);

    state.transform = renderer.projection.transform;
    renderer.projection.transform = null;
    renderTextureSystem.bind(state.renderTexture, state.sourceFrame, destinationFrame);

    const cc = filters[filters.length - 1].clearColor as any;

    if (cc) {
        // take clear color from filter, it helps for advanced DisplacementFilter
        renderer.framebuffer.clear(cc[0], cc[1], cc[2], cc[3]);
    } else {
        renderer.framebuffer.clear(0, 0, 0, 0);
    }

    return true;
}

function push(this: IPictureFilterSystem,
              target: DisplayObject, filters: Array<Filter>) {
    return this.pushWithCheck(target, filters, false);
}

function pop(this: IPictureFilterSystem) {
    const filterStack = this.defaultFilterStack;
    const state = filterStack.pop();
    const filters = state.filters as Array<BackdropFilter>;

    this.activeState = state;

    const globalUniforms = this.globalUniforms.uniforms;

    globalUniforms.outputFrame = state.sourceFrame;
    globalUniforms.resolution = state.resolution;

    const inputSize = globalUniforms.inputSize;
    const inputPixel = globalUniforms.inputPixel;
    const inputClamp = globalUniforms.inputClamp;

    inputSize[0] = state.destinationFrame.width;
    inputSize[1] = state.destinationFrame.height;
    inputSize[2] = 1.0 / inputSize[0];
    inputSize[3] = 1.0 / inputSize[1];

    inputPixel[0] = inputSize[0] * state.resolution;
    inputPixel[1] = inputSize[1] * state.resolution;
    inputPixel[2] = 1.0 / inputPixel[0];
    inputPixel[3] = 1.0 / inputPixel[1];

    inputClamp[0] = 0.5 * inputPixel[2];
    inputClamp[1] = 0.5 * inputPixel[3];
    inputClamp[2] = (state.sourceFrame.width * inputSize[2]) - (0.5 * inputPixel[2]);
    inputClamp[3] = (state.sourceFrame.height * inputSize[3]) - (0.5 * inputPixel[3]);

    // only update the rect if its legacy..
    if (state.legacy)
    {
        const filterArea = globalUniforms.filterArea;

        filterArea[0] = state.destinationFrame.width;
        filterArea[1] = state.destinationFrame.height;
        filterArea[2] = state.sourceFrame.x;
        filterArea[3] = state.sourceFrame.y;

        globalUniforms.filterClamp = globalUniforms.inputClamp;
    }

    this.globalUniforms.update();

    const lastState = filterStack[filterStack.length - 1];

    if (state.renderTexture.framebuffer.multisample > 1)
    {
        this.renderer.framebuffer.blit();
    }

    if (filters.length === 1)
    {
        filters[0].apply(this, state.renderTexture, lastState.renderTexture, CLEAR_MODES.BLEND, state);

        this.returnFilterTexture(state.renderTexture);
    }
    else
    {
        let flip = state.renderTexture;
        let flop = this.getOptimalFilterTexture(
            flip.width,
            flip.height,
            state.resolution
        );

        flop.filterFrame = flip.filterFrame;

        let i = 0;

        for (i = 0; i < filters.length - 1; ++i)
        {
            filters[i].apply(this, flip, flop, CLEAR_MODES.CLEAR, state);

            const t = flip;

            flip = flop;
            flop = t;
        }

        filters[i].apply(this, flip, lastState.renderTexture, CLEAR_MODES.BLEND, state);

        this.returnFilterTexture(flip);
        this.returnFilterTexture(flop);
    }

    // release the backdrop!
    let backdropFree = false;

    for (let i = 0; i < filters.length; i++) {
        if (filters[i]._backdropActive) {
            const bName = filters[i].backdropUniformName;
            if (!backdropFree) {
                this.returnFilterTexture(filters[i].uniforms[bName]);
                backdropFree = true;
            }
            filters[i].uniforms[bName] = null;
            filters[i]._backdropActive = false;
        }
    }

    state.clear();
    this.statePool.push(state);
}

let hadBackbufferError = false;

/**
 * Takes a part of current render target corresponding to bounds
 * fits sourceFrame to current render target frame to evade problems
 */
function prepareBackdrop(bounds: Rectangle, flipY: Float32Array): RenderTexture {
    const renderer = this.renderer;
    const renderTarget = renderer.renderTexture.current;
    const fr = this.renderer.renderTexture.sourceFrame;
    const tf = renderer.projection.transform || Matrix.IDENTITY;

    //TODO: take non-standart sourceFrame/destinationFrame into account, all according to ShukantPal refactoring

    let resolution = 1;
    if (renderTarget) {
        resolution = renderTarget.baseTexture.resolution;
        flipY[1] = 1.0;
    } else {
        if (!renderer.useContextAlpha) {
            if (!hadBackbufferError) {
                hadBackbufferError = true;
                console.warn('pixi-picture: you are trying to use Blend Filter on main framebuffer! That wont work.');
            }
            return null;
        }
        resolution = renderer.resolution;
        flipY[1] = -1.0;
    }

    //bounds.fit(fr);

    const x = Math.round((bounds.x - fr.x + tf.tx) * resolution);
    const dy = bounds.y - fr.y + tf.ty;
    const y = Math.round((flipY[1] < 0.0 ? fr.height - (dy + bounds.height) : dy) * resolution);
    const w = Math.round(bounds.width * resolution);
    const h = Math.round(bounds.height * resolution);

    const gl = renderer.gl;
    const rt = this.getOptimalFilterTexture(w, h, 1);

    if (flipY[1] < 0) {
        flipY[0] = h / rt.height;
    }

    rt.filterFrame = fr;
    rt.setResolution(resolution);
    renderer.texture.bindForceLocation(rt.baseTexture, 0);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x, y, w, h);
    return rt;
}

export function applyMixins() {
    (TextureSystem as any).prototype.bindForceLocation = bindForceLocation;
    (FilterSystem as any).prototype.push = push;
    (FilterSystem as any).prototype.pushWithCheck = pushWithCheck as any;
    (FilterSystem as any).prototype.pop = pop;
    (FilterSystem as any).prototype.prepareBackdrop = prepareBackdrop;
}
