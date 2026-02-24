document.addEventListener('DOMContentLoaded', () => {
    let cartCount = 0;
    const cartCountElement = document.getElementById('cart-count');
    const addToCartButtons = document.querySelectorAll('.add-to-cart');
    const cartButton = document.getElementById('cart-btn');

    addToCartButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            cartCount++;
            cartCountElement.textContent = cartCount;
            
            const originalText = e.target.textContent;
            e.target.textContent = "Added!";
            e.target.style.background = "#4CAF50"; 
            
            setTimeout(() => {
                e.target.textContent = originalText;
                e.target.style.background = ""; 
            }, 1000);
        });
    });

    cartButton.addEventListener('click', () => {
        if (cartCount === 0) {
            alert("Your cart is empty!");
        } else {
            alert(`Proceeding to demo checkout with ${cartCount} items...`);
        }
    });

    document.getElementById('chat-btn').addEventListener('click', () => {
        alert("Live chat connecting...");
    });
});
