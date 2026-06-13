# Animation & Transition

<div id="canvas">
    <div class="loading"></div>
</div>

<style>
    #canvas {
        background: #000;
        min-height: 400px;
        border-radius: 12px;
        position: relative;
        margin-top: 16px;
    }

    .loading {
        height: 50px;
        width: 50px;
        border: 6px solid aqua;
        border-radius: 4px;

        box-shadow: 0 0 8px aqua, 0 0 8px aqua inset;

        position: absolute;
        top: 50%;
        left: 50%;
        translate: -50% -50%;

        animation: 2s loading ease-in-out infinite;
    }

    @keyframes loading {
        0% { transform: rotateX(0) rotateY(0) rotateZ(0); }
        33% { transform: rotateX(180deg) rotateY(0) rotateZ(0); }
        67% { transform: rotateX(180deg) rotateY(180deg) rotateZ(0); }
        100% { transform: rotateX(180deg) rotateY(180deg) rotateZ(180deg); }
    }
</style>
