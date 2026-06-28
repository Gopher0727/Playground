// 给代码块添加语言标识，放在复制按钮旁边
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.highlight').forEach(function (block) {
        var match = block.className.match(/language-(\w+)/);
        if (!match) return;
        var lang = match[1].toUpperCase();
        var label = document.createElement('span');
        label.className = 'md-code-lang';
        label.textContent = lang;
        // 找到 Material 注入的复制按钮，把标签插在它前面
        var btn = block.querySelector('.md-code__button[data-md-type="copy"]');
        if (btn && btn.parentNode) {
            btn.parentNode.insertBefore(label, btn);
        }
    });
});
