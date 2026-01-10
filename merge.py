with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

with open('style.css', 'r', encoding='utf-8') as f:
    css = f.read()

with open('toast.css', 'r', encoding='utf-8') as f:
    toast_css = f.read()

with open('app.js', 'r', encoding='utf-8') as f:
    js = f.read()

# Inline CSS
html = html.replace('<link rel="stylesheet" href="style.css">', f'<style>\n{css}\n{toast_css}\n</style>')

# Inline JS
html = html.replace('<script src="app.js"></script>', f'<script>\n{js}\n</script>')

with open('single_file_app.html', 'w', encoding='utf-8') as f:
    f.write(html)
