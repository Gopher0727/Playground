# Pseudo Elements

<style>
    h1 {
        position: relative;
        width: max-content;
    }

    h1::after {
        content: "";

        position: absolute;
        /* display: block; */

        background: linear-gradient(to right bottom, blue, red);
        border-radius: 10px;

        height: 4px;
        width: 100%;

        bottom: 0;
        left: 0;

        transition: 100ms;
    }

    h1:hover::after {
        width: 0;
    }
</style>