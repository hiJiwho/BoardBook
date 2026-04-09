const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let isDrawing = false;
let currentTool = 'pencil';
let currentColor = '#000';
let currentSize = 3;

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // Restore state if needed, but for now just clear
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}
window.onresize = resize;
resize();

canvas.onmousedown = (e) => {
    isDrawing = true;
    ctx.beginPath();
    ctx.moveTo(e.clientX, e.clientY);
};

canvas.onmousemove = (e) => {
    if (!isDrawing) return;
    ctx.strokeStyle = currentTool === 'eraser' ? '#fff' : currentColor;
    ctx.lineWidth = currentTool === 'eraser' ? 20 : currentSize;
    ctx.lineTo(e.clientX, e.clientY);
    ctx.stroke();
};

canvas.onmouseup = () => isDrawing = false;
canvas.onmouseleave = () => isDrawing = false;

// Touch support
canvas.ontouchstart = (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    isDrawing = true;
    ctx.beginPath();
    ctx.moveTo(touch.clientX, touch.clientY);
};
canvas.ontouchmove = (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    if (!isDrawing) return;
    ctx.strokeStyle = currentTool === 'eraser' ? '#fff' : currentColor;
    ctx.lineWidth = currentTool === 'eraser' ? 20 : currentSize;
    ctx.lineTo(touch.clientX, touch.clientY);
    ctx.stroke();
};

document.getElementById('toolPencil').onclick = () => {
    currentTool = 'pencil';
    document.getElementById('toolPencil').classList.add('active');
    document.getElementById('toolEraser').classList.remove('active');
};
document.getElementById('toolEraser').onclick = () => {
    currentTool = 'eraser';
    document.getElementById('toolEraser').classList.add('active');
    document.getElementById('toolPencil').classList.remove('active');
};
document.getElementById('toolClear').onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
};
document.getElementById('toolClose').onclick = () => {
    window.close();
};

document.querySelectorAll('.color-dot').forEach(dot => {
    dot.onclick = () => {
        currentColor = dot.dataset.color;
        document.querySelector('.color-dot.active').classList.remove('active');
        dot.classList.add('active');
        currentTool = 'pencil';
        document.getElementById('toolPencil').classList.add('active');
        document.getElementById('toolEraser').classList.remove('active');
    };
});
