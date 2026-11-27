// Two independently addressed synchronous dictionary reads.
// Load all entries before enabling requests; no writes during operation.
// 1024 x 10 bits per port, duplicated for synthesis portability.
// Target: one clock from address sampling to valid output, not a measured Fmax.
module s10_dictionary_sram(
 input wire clk, input wire rst,
 input wire cfg_we, input wire [9:0] cfg_addr, input wire [9:0] cfg_value,
 input wire cfg_commit, output reg configured,
 input wire req_valid, input wire [9:0] addr_a, addr_b,
 output reg resp_valid, output reg [9:0] value_a, value_b
);
 reg [9:0] mem_a [0:1023];
 reg [9:0] mem_b [0:1023];
 reg [10:0] loaded;
 // Require sequential load from address 0; reject a skipped/repeated address.
 // Reset before loading a different dictionary. Host validates permutation.
 always @(posedge clk) begin
  if(rst) begin configured<=0; loaded<=0; resp_valid<=0; end
  else begin
   resp_valid<=configured && req_valid;
   if(!configured && cfg_we && loaded<1024 && cfg_addr==loaded[9:0]) begin
    mem_a[cfg_addr]<=cfg_value; mem_b[cfg_addr]<=cfg_value; loaded<=loaded+1'b1;
   end
   if(!configured && cfg_commit && !cfg_we && loaded==1024) configured<=1;
   if(configured && req_valid) begin value_a<=mem_a[addr_a];value_b<=mem_b[addr_b];end
  end
 end
endmodule
