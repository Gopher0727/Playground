document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("vditor")) {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/vditor/dist/index.min.js";
        script.onload = function () {
            new Vditor("vditor", {
                height: 600,
                mode: "wysiwyg",
                cache: { enable: false },
            });
        };
        document.head.appendChild(script);

        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://cdn.jsdelivr.net/npm/vditor/dist/index.css";
        document.head.appendChild(link);
    }
});
